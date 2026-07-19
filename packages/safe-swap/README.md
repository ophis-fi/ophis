# @ophis/safe-swap

Headless [Ophis](https://ophis.fi) (CoW Protocol) swap builder for a **vault Safe**: a
vault curator / manager (a Safe driven by a Zodiac Roles Modifier, an MPC signer, or a
multisig) rebalances the vault's underlying assets through Ophis as one atomic,
MEV-protected CoW order. The vault Safe is BOTH `order.from` and `order.receiver`, so
funds never leave its control, and the order carries the Ophis partner fee.

This package builds the order + the on-chain tx batch. It never holds keys and (for the
core builder) never imports a wallet SDK.

> Maturity: published to npm and live. The Phase-B **on-chain policy module**
> (`OphisVaultPolicyModule`) is deployed and has settled real module-gated
> rebalances on five chains (Ethereum, Optimism, Base, Arbitrum, Unichain) — it is
> the strongest curator model and the recommended one (model C below). The module
> contracts went through a 12-agent adversarial audit, Trail of Bits semgrep,
> Echidna/Foundry invariant fuzzing, and independent review. See "Security".

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

const { orderUid, order, fullAppData, txs, settlement, relayer, enrollmentWarning } =
  await buildOphisSafePresign({
    chainId: 130,                 // Unichain (or 10 = OP, 1, 8453, 42161, ...)
    safe: vaultSafeAddress,       // order.from AND order.receiver
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: '1000000',        // ATOMIC gross to sell (base units)
    minBuyAmount: curatorMinOut,  // ATOMIC hard floor; recommended for any real size
    slippageBps: 50,
    ttlSeconds: 1500,             // optional; default 1800, capped at 3600
  })
// Direct path: `txs` is [approve?, setPreSignature(orderUid, true)] — execute AS the Safe.
// Policy-module path (model C): pass `order` to `module.rebalance(order, minBuyOverride)`
// from the curator key; the module re-derives the same uid and presigns on-chain.
```

`buildOphisSafePresign` quotes against the Ophis orderbook (receiver pinned to the Safe),
assembles a hardened order, POSTs it `PRESIGNATURE_PENDING` to get the `orderUid`, and
returns the raw tx batch. **Execution is up to you** — pick a curator model below.

## Chains

Works on every chain with a **live Ophis / CoW orderbook** — `@ophis/sdk` looks up settlement /
relayer / orderbook / signing domain by `chainId`, with no per-chain code. (A few chain IDs
resolve a settlement but have no live orderbook, e.g. paused chains like 4326 / 999; those
throw at the quote step and are not tradeable.)

- **Ophis self-hosted** (non-canonical settlement, 100% fee): Optimism, Unichain.
- **CoW-hosted** (canonical settlement, fee via appData): Ethereum, Base, Arbitrum, Polygon,
  Gnosis, BNB, Avalanche, Linea, Ink, Plasma.

The batch's **on-chain effects** are fork-verified against the REAL deployed contracts on all
12 — each deploys a Safe, funds the sell token, executes `[approve, setPreSignature]`, and
asserts exact allowance to the real relayer + presignature recorded in the real settlement +
exact-pull. This proves the on-chain surface the builder produces; it does NOT quote/submit an
order or run a solver settlement (a fork has no solver network — that is covered by the
monitored real-chain rollout). (Plasma has no USDC yet, so its check uses a WETH9 -> USDT0 pair.)

## Curator model C: on-chain policy module (strongest, recommended)

Deploy an `OphisVaultPolicyModule` for the vault (factory + per-chain deploy scripts in
`contracts/script/`), enable it on the Safe, and give the curator key exactly two
entrypoints: `module.rebalance(order, minBuyOverride)` and `module.cancel(orderUid)`.
The module re-checks EVERY order field on-chain before presigning — receiver pinned to
the Safe, token allowlist, Chainlink oracle price floor, pinned partner-fee appData,
zero signed fee, TTL ceiling, rolling daily USD turnover cap — so a compromised curator
key cannot drain the vault, only trigger policy-valid rebalances inside that envelope.

```ts
const { order } = await buildOphisSafePresign({ ...params, ttlSeconds: 1500 })
// curator key calls: module.rebalance(order, 0)
// the module re-derives the same orderUid, sets an EXACT allowance, and presigns.
```

Live on Ethereum, Optimism, Base, Arbitrum, and Unichain with real settled rebalances.
Operator guide: `docs/operations/vault-policy-module-trial-runbook.md` in the repo.

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

**Residual (disclosed):** with curator models A/B, presign + Roles bound the on-chain
SURFACE (approve-the-relayer + presign-the-settlement, nothing else), but they cannot
enforce receiver / fee / minOut inside the `setPreSignature` calldata — those rest on the
off-chain builder guards plus the vault's guardian / timelock. The true "curator cannot
drain even if its key leaks" guarantee is **curator model C: the on-chain policy module**
(decodes the full order on-chain and asserts receiver == vault + token allowlist +
oracle floor + pinned appData + turnover cap) — built, audited (12-agent adversarial
pass + Trail of Bits semgrep + Echidna/Foundry invariants), and live on five chains.

> **With models A/B (no policy module), treat the curator MPC / Roles key as full
> vault-owner-level custody.** A compromised curator key can `approve(relayer, MaxUint)`
> (the Roles preset pins the spender but not the amount) and `setPreSignature` a
> self-crafted drain order (owner = the Safe, receiver = attacker), then settle it.
> With model C, a compromised curator is bounded to policy-valid rebalances: worst case
> is price bleed inside the oracle-floor band, capped by the module's daily USD turnover
> budget. Prefer model C for any real deployment.

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
