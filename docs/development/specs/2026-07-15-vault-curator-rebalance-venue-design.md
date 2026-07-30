# Ophis Vault Curator Rebalance Venue - Phase A

- Date: 2026-07-15
- Status: design approved; implementation in progress
- Branch: `feat/vault-curator-swaps`

## Goal

Make Ophis the DEX a vault curator / manager uses to rebalance the vault's
UNDERLYING assets. The target is an async (ERC-7540) vault whose curator
(a Safe with a Zodiac Roles Modifier, or an MPC signer) runs the strategy
off-vault and periodically swaps underlying (e.g. USDC -> WETH). Phase A makes
the vault Safe place that swap as an Ophis CoW-Protocol order: atomic,
MEV-protected, funds return to the vault Safe.

- Phase A (this doc): curator rebalance venue. Atomic CoW. In scope now.
- Phase B (sketch only): user-facing async ERC-7540 deposit/redeem. Later.

## Key finding: the presign spine already exists

`apps/safe-app/src/lib/submit.ts` already implements exactly this flow for a
Safe (the Bankr precedent): place an Ophis order with `signingScheme=PRESIGN`
(signature = the Safe address), then execute
`GPv2Settlement.setPreSignature(orderUid, true)` on-chain, with the
approve-to-relayer prepended into one atomic batch. Trader AND receiver are
pinned to the Safe. The `@ophis/sdk` order-construction primitives
(`buildOphisOrderMetadata`, `buildOphisOrderCreation`, `ophisOrderReceiver` /
`assertReceiverIsOwner`, `getOphisSettlementAddress` / `getOphisVaultRelayer` /
`getOphisOrderDomain`, `buildOphisAppDataPartnerFee`) are dependency-free and
signing-scheme-agnostic, so they are reused as-is.

The gap is packaging: `submit.ts` is coupled to `@safe-global/safe-apps-sdk`
(iframe `sdk.txs.send`) and only PROPOSES a Safe tx for human co-signers. A
curator bot must obtain the raw tx batch and route it through Roles / MPC /
multisig itself. Phase A extracts that spine into a delivery-agnostic module.

## MVP surface

New package `@ophis/safe-swap` exporting one headless builder:

```ts
buildOphisSafePresign(params): Promise<{ orderUid, txs, settlement, relayer }>
```

It quotes (receiver pinned to the Safe), builds the fee-bearing appData,
assembles a receiver-pinned order with the hardened request-binding guards,
POSTs it `PRESIGNATURE_PENDING` to obtain the orderUid, and RETURNS the raw tx
batch `[approve0?, approve(exact), setPreSignature(uid, true)]` plus the
orderUid. Execution is left to the curation layer. Ships with a Zodiac Roles
preset that scopes a curator role to exactly the two Ophis call shapes.

### Public interface

```ts
export const MAX_SLIPPAGE_BPS = 5000

export interface OphisSafePresignParams {
  chainId: number
  safe: `0x${string}`          // vault Safe: order.from AND order.receiver
  sellToken: `0x${string}`
  buyToken: `0x${string}`
  sellAmount: string           // ATOMIC base units (wei), the gross to sell
  minBuyAmount?: string        // ATOMIC hard min-out; signed floor must meet it
  slippageBps?: number         // default 50; hard-capped at MAX_SLIPPAGE_BPS
  referralCode?: string
  isStablePair?: boolean       // 1bp stable vs 5bp partner volume fee
  readAllowance?: (token, owner, spender) => Promise<bigint>  // omit -> defensive approve
}

export interface OphisSafePresignResult {
  orderUid: string
  txs: { to: `0x${string}`; value: string; data: `0x${string}` }[]
  settlement: `0x${string}`
  relayer: `0x${string}`
  explorerUrl?: string
}

export function buildOphisSafePresign(p: OphisSafePresignParams): Promise<OphisSafePresignResult>
export function ophisCuratorRolesPreset(p: OphisCuratorRolesParams): PermissionSet
export function executeOphisSafePresign(signer, safe, batch): Promise<{ safeTxHash }>  // optional MPC adapter
```

## Security invariants

These are enforced in code, asserted by unit tests, and checked by ToB-semgrep
+ Codex before merge.

| # | Sev | Invariant | Enforced by |
|---|-----|-----------|-------------|
| 0 | CRITICAL | The presigned `orderUid` is re-derived LOCALLY from the guarded order (`computeOrderUid`) and MUST equal the host-returned uid (`assertUidMatches`); the curator never presigns a host-supplied uid. Without this, a compromised orderbook host could return a DIFFERENT order's uid (owner == the Safe, but an attacker receiver / arbitrary amounts) and the curator would presign a drain the local guards never inspected. | `assertUidMatches` in `order.ts` (digest cross-checked vs ethers v6 + a golden-vector unit test); throws on any mismatch |
| 1 | CRITICAL | Signed order `feeAmount` is exactly `"0"`; the quote's feeAmount is NEVER signed. Fee rides only in appData partnerFee. | `build.ts` hardcodes `'0'`; `guards.ts` rejects non-zero signed fee; unit test + semgrep |
| 2 | CRITICAL | `order.receiver == the vault Safe`; no custom-receiver knob on the vault path. | `ophisOrderReceiver(safe)` + `assertReceiverIsOwner`; unit test throws on foreign receiver |
| 3 | CRITICAL | appData partnerFee recipient == `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`, non-zero bps, emitted on every order (esp. Base, no ingress floor). | `buildOphisAppDataPartnerFee`; frozen recipient constant; unit test |
| 4 | CRITICAL | `setPreSignature` target == `getOphisSettlementAddress(chainId)` (the SDK-resolved settlement) and `computeOrderUid` uses the matching domain. Note: this is the Ophis NON-canonical settlement on self-hosted OP(10)/Unichain(130), where hardcoding canonical CoW would bypass the Ophis settlement + fee; it is CANONICAL CoW on CoW-hosted chains (e.g. Base) where the fee still rides in appData. The invariant is "use the SDK-resolved address, never a hardcoded one," not "never canonical." | `build.ts` + `computeOrderUid` resolve from `@ophis/sdk` only; per-chain unit tests (OP/Unichain non-canonical) |
| 5 | HIGH | approve spender == `getOphisVaultRelayer(chainId)`, EXACT amount (`sellAmount+feeAmount`), never MaxUint256; USDT-style allowance reset to 0 first. | `build.ts` least-privilege approve; Roles preset caps amount + pins spender; unit test |
| 6 | HIGH | Order bound to the request: `sellToken`/`buyToken` == requested; `grossSell (quote sellAmount+feeAmount) == requested sellAmount`. | `guards.ts` ported from `swap.ts:210-217`; unit tests |
| 7 | HIGH | `buyAmount` floor > 0 (reject zero-proceeds bait); `slippageBps <= MAX_SLIPPAGE_BPS`; and if the caller passes `minBuyAmount`, the signed buy floor MUST meet it. The zero check alone lets a hostile host fill at a tiny-but-nonzero price; the curator has its own NAV/valuation, so it supplies a hard min-out (no Ophis oracle needed). | `guards.ts` `assertBuyFloor(buyAmount, minBuyAmount?)`; unit tests incl. the `buyAmount=2` case |
| 8 | HIGH | Zodiac Roles curator role scoped to EXACTLY the two Ophis calls; forbids transfer/transferFrom, foreign-spender approve, all other targets. | `ophisCuratorRolesPreset()`; fork test |
| 9 | MEDIUM | `validTo` set locally (`now + TTL`), not trusted from the quote; `partiallyFillable == false`. | `build.ts`; unit tests |

Residual risk (disclosed candidly in the README): presign + Roles bound the
on-chain SURFACE (only approve-Ophis-relayer + presign-Ophis-settlement, no
arbitrary asset control), but they CANNOT enforce receiver / fee / minOut in the
`setPreSignature` calldata. Those rest on the off-chain builder guards plus the
vault guardian / timelock. The Phase-B EIP-1271 policy module is the path that
closes that residual (the only "curator cannot drain even if its key leaks"
guarantee).

## Components

Create:
- `packages/safe-swap/src/build.ts` - `buildOphisSafePresign()` (lift of submit.ts, transport-agnostic)
- `packages/safe-swap/src/guards.ts` - ported request-binding hardening from `agent-swap/src/swap.ts`
- `packages/safe-swap/src/roles-preset.ts` - `ophisCuratorRolesPreset()` (zodiac-roles-sdk)
- `packages/safe-swap/src/exec-safe.ts` - optional MPC executor adapter (protocol-kit)
- `packages/safe-swap/src/index.ts`, `package.json`, `README.md`
- `packages/safe-swap/test/build.test.ts`, `test/roles-preset.test.ts`

Modify:
- `apps/safe-app/src/lib/order.ts` - consume `@ophis/safe-swap` guards (force feeAmount '0', local validTo, slippage cap, reject zero floor)
- `apps/safe-app/src/lib/submit.ts` - build the batch via the shared builder, inject Safe-Apps SDK as transport
- `packages/sdk/src/flow.ts` - confirm `buildOphisOrderCreation` presign wire body
- `pnpm-workspace.yaml` / root tsconfig / CI - register the new package

## Test plan

- UNIT: every invariant above (feeAmount 0, receiver pin, token/gross bind, zero-floor, slippage cap, exact USDT-safe approve, per-chain settlement/relayer, local validTo, partiallyFillable false, tx batch order).
- UNIT (roles): preset allows the two Ophis calls; denies transfer/transferFrom, foreign-spender approve, canonical-settlement presign, other targets.
- INTEGRATION (fork, Unichain/OP/Base): deploy a Safe, build, execute `[approve, setPreSignature]` via protocol-kit under a curator key, drive settlement, assert bought token returns to the Safe and the fee lands at `0x858...CeF8`.
- REGRESSION: safe-app refactor emits an identical batch and inherits the guards (snapshot/diff).
- NEGATIVE: quote host returning non-zero feeAmount / mismatched tokens / tiny buyAmount / far-future validTo is rejected (fail-closed).

## Milestones

- M1 - Extract and harden the builder: `@ophis/safe-swap` (build.ts + guards.ts), wire the presign creation branch, refactor `apps/safe-app` to consume it (guard-parity fix). All unit tests + semgrep green.
- M2 - Headless executor: `exec-safe.ts` (protocol-kit MPC exec). Fork integration test: funds-return-to-Safe + fee-to-0x858 on Unichain + OP.
- M3 - Zodiac Roles preset + fork security proof (least-privilege). Curator README.
- M4 - Gated rollout: Unichain (130) first, then OP (10), Base (8453) secondary [CONFIRMED by Clement 2026-07-16]. All three chains fork-verified against the REAL deployed contracts (Base uses the CANONICAL CoW settlement/relayer, being CoW-hosted). Gates: ToB-semgrep 0 findings, final Codex/adversarial audit, CI green. Enablement is operational (no new contracts are deployed; the builder resolves each chain's settlement/relayer/orderbook from @ophis/sdk).

## Decisions (open questions resolved)

- Native-ETH: OUT for v1 (ERC-20 underlying only; drop the wrapNative branch).
- Curator exec model: the builder is exec-agnostic; MPC executor (M2) before Roles preset (M3).
- EIP-1271 on-chain policy module: Phase B (presign + Roles + candid disclosure for Phase A).
- Fee: standard 5bp partner / 1bp stable via the single allowlisted `0x858` recipient; any curator-specific split handled off-chain on that recipient (no new allowlisted Safe, no re-audit).
- Chain priority: Unichain -> OP -> Base [Clement 2026-07-16]. Unichain + OP are self-hosted (100% fee, non-canonical settlement); Base is CoW-hosted (canonical settlement, fee via appData).
- Rebate-attribution: DECIDED PER PARTNER at onboarding [Clement 2026-07-16]. The code ships attribution-agnostic (optional `referralCode`), so no global policy is baked in.

## Phase B sketch (later)

- Ophis becomes the swap venue INSIDE the vault's epoch/settle lifecycle: convert deposit assets -> underlying on deposit settlement and underlying -> redemption asset on redeem settlement, one netted swap per epoch.
- EIP-1271 on-chain policy validator / Safe module that decodes the FULL order and asserts receiver == vault, token allowlist, and minOut >= oracle before the digest is honored (the real on-chain boundary presign + Roles cannot provide).
- Oracle-gated fair-value / minOut check as a settlement precondition.
- Integrate with the vault's Silo / settlement contracts and epoch batching; add a keeper/watchtower for multi-step settlement.
- Re-analyse partial fills + surplus/fee accounting before enabling `partiallyFillable=true`.
