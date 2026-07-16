# @ophis/safe-swap

Headless [Ophis](https://ophis.fi) (CoW Protocol) swap builder for a **vault Safe**: a
vault curator / manager (a Safe driven by a Zodiac Roles Modifier, an MPC signer, or a
multisig) rebalances the vault's underlying assets through Ophis as one atomic,
MEV-protected CoW order. The vault Safe is BOTH `order.from` and `order.receiver`, so
funds never leave its control, and the order carries the Ophis partner fee.

This package builds the order + the on-chain tx batch. It never holds keys and (for the
core builder) never imports a wallet SDK.

> Maturity: this is Phase A (curator rebalance venue). M1–M3 are implemented and
> unit + fork tested; it is **not yet published to npm or enabled on mainnet** — that is
> M4's gated, monitored rollout. The strongest "curator cannot drain even if its key
> leaks" guarantee is the Phase-B EIP-1271 policy module (not built). See "Security".

## Install

```bash
pnpm add @ophis/safe-swap
# optional, only for the batteries-included executor / Roles preset:
pnpm add @safe-global/protocol-kit    # for @ophis/safe-swap/exec-safe
pnpm add zodiac-roles-sdk             # for @ophis/safe-swap/roles-preset
```

## Quick start

```ts
import { buildOphisSafePresign } from '@ophis/safe-swap'

const { orderUid, txs, settlement, relayer, enrollmentWarning } = await buildOphisSafePresign({
  chainId: 130,                 // Unichain (or 10 = OP)
  safe: vaultSafeAddress,       // order.from AND order.receiver
  sellToken: USDC,
  buyToken: WETH,
  sellAmount: '1000000',        // ATOMIC gross to sell (base units)
  minBuyAmount: curatorMinOut,  // ATOMIC hard floor; recommended for any real size
  slippageBps: 50,
})
// `txs` is [approve?, setPreSignature(orderUid, true)] — execute it AS the Safe.
```

`buildOphisSafePresign` quotes against the Ophis orderbook (receiver pinned to the Safe),
assembles a hardened order, POSTs it `PRESIGNATURE_PENDING` to get the `orderUid`, and
returns the raw tx batch. **Execution is up to you** — pick a curator model below.

## Chains

Works on every chain `@ophis/sdk` resolves — settlement / relayer / orderbook / signing
domain are looked up by `chainId`, with no per-chain code:

- **Ophis self-hosted** (non-canonical settlement, 100% fee): Optimism, Unichain.
- **CoW-hosted** (canonical settlement, fee via appData): Ethereum, Base, Arbitrum, Polygon,
  Gnosis, BNB, Avalanche, Linea, Ink, Plasma.

Fork-verified end-to-end against the REAL deployed contracts on 10 of these (OP, Unichain,
Base, Ethereum, Arbitrum, Polygon, Gnosis, Avalanche, BNB, Linea). Ink + Plasma use the
identical canonical path; add a fundable sell token + fork RPC to `test/fork` to verify them.

## Curator model A: MPC / owner key (protocol-kit)

```ts
import { executeOphisSafePresign } from '@ophis/safe-swap/exec-safe'

const res = await executeOphisSafePresign({
  provider: RPC_URL,
  signer: CURATOR_MPC_KEY,      // an owner / MPC signer of the Safe
  safe: vaultSafeAddress,
  txs,                          // from buildOphisSafePresign
})
// res.executed === true only after the batch mined AND the Safe did not emit
// ExecutionFailure. For a multisig (threshold > 1) it returns res.executed === false
// with res.safeTxHash + res.signatures for you to collect the remaining co-signatures.
```

The batch is submitted MultiSendCallOnly (no attacker delegatecall). This adapter
**trusts the batch it is handed** — always pass the exact output of `buildOphisSafePresign`.

## Curator model B: Zodiac Roles Modifier (least-privilege)

Scope a curator ROLE to EXACTLY the two calls a rebalance needs, so a compromised curator
key can do nothing else on-chain:

```ts
import { ophisCuratorRolesPreset } from '@ophis/safe-swap/roles-preset'
import { processPermissions, /* apply flow */ } from 'zodiac-roles-sdk'

const preset = ophisCuratorRolesPreset({
  chainId: 130,
  sellTokens: [USDC, WETH],     // the underlyings the curator may approve
})
// Apply `preset` to the curator role on your Roles Modifier via the zodiac-roles-sdk
// apply flow; the Roles Modifier then executes the batch under that role.
```

The Roles Modifier is default-DENY. The preset grants only:

- `approve(spender, amount)` on each underlying, with `spender` **pinned to the Ophis
  relayer** (amount unconstrained — it varies per rebalance; the builder sets it exact).
- `setPreSignature(orderUid, signed)` on the **Ophis** settlement (the canonical CoW
  settlement is a different address and is denied).

Everything else — `transfer` / `transferFrom`, approving a foreign spender, presigning on
the canonical settlement, any other target — is rejected on-chain.

## Security

Enforced in code and unit-tested (fail-closed):

- **uid binding** — the `orderUid` is re-derived locally and must equal the host-returned
  uid; the curator never presigns a uid the host handed back.
- receiver pinned to the Safe; signed `feeAmount` is `"0"` (fee only in appData); appData
  partner-fee to the frozen recipient; settlement resolved from `@ophis/sdk`, never hardcoded.
- approve is EXACT to the correct relayer (never MaxUint; USDT-safe reset; clamps a
  pre-existing oversized allowance, unless `keepSufficientAllowance` is set).
- request binding (tokens + gross), buy-floor > 0 + optional caller hard min-out, slippage
  cap, local `validTo`, `partiallyFillable=false`.

**Residual (disclosed):** presign + Roles bound the on-chain SURFACE (approve-the-relayer +
presign-the-settlement, nothing else), but they cannot enforce receiver / fee / minOut
inside the `setPreSignature` calldata. Those rest on the off-chain builder guards plus the
vault's guardian / timelock. The only true "curator cannot drain even if its key leaks"
guarantee is the Phase-B on-chain EIP-1271 policy module (decodes the full order and asserts
receiver == vault + token allowlist + minOut >= oracle) — not yet built.

> **Until Phase B, treat the curator MPC / Roles key as full vault-owner-level custody.**
> A compromised curator key can `approve(relayer, MaxUint)` (the Roles preset pins the
> spender but not the amount) and `setPreSignature` a self-crafted drain order (owner = the
> Safe, receiver = attacker), then settle it. The Roles preset confines a *not-yet-abused*
> key to the two Ophis call shapes and denies every other target; it does **not** stop a
> drain by an already-compromised key. Grant the curator key only to something you would
> trust to move vault funds directly.

Note: `buildOphisSafePresign` / `submitOrder` clamp a pre-existing oversized relayer
allowance to exact by default (least-privilege). If a Safe deliberately keeps ONE shared
allowance across several **concurrent** presigned orders, pass `keepSufficientAllowance: true`
so the clamp doesn't make the other in-flight orders unfillable.

## Testing

```bash
pnpm --filter @ophis/safe-swap test        # unit tests (guards, order/uid, executor, roles preset)

# Fork integration tests (env-gated, need anvil + a fork RPC). They deploy a real Safe,
# fund it, execute the batch against the REAL deployed OP / Unichain contracts, and assert
# exact allowance + presignature-in-real-settlement + exact-pull. A local fork has no CoW
# solver network, so end-to-end settlement + the partner-fee transfer is validated by M4's
# monitored real-chain rollout, not here.
OPHIS_FORK_RPC=https://mainnet.optimism.io \
OPHIS_FORK_RPC_UNICHAIN=https://mainnet.unichain.org \
  pnpm --filter @ophis/safe-swap test:fork
```

## License

GPL-3.0-or-later
