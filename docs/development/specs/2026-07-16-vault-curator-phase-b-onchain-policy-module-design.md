# Ophis Vault Curator Rebalance Venue - Phase B: on-chain order-policy module

Status: DESIGN (B0 deliverable, awaiting review). Supersedes the one-line "Phase B
sketch" in `2026-07-15-vault-curator-rebalance-venue-design.md`. Architecture chosen
after the B0 research spike (2026-07-16).

## Provenance / the one thing to read first

The Phase-A spec called this "the EIP-1271 policy module." The B0 research shows the
GUARANTEE we want is better delivered by a **bespoke Safe module that gates PRESIGN**
than by an EIP-1271 verifier. The mechanism changed; the guarantee did not:

> Decode the FULL CoW order on-chain and enforce `receiver == vault` + token allowlist
> + `minOut >= oracle floor` BEFORE the order can ever be presigned (hence before it can
> settle), so the curator key cannot drain the vault even if it leaks.

Why the mechanism changed: an EIP-1271 verifier would reuse CoW's audited
`ExtensibleFallbackHandler` / `ComposableCoW` stack, but that stack is **not deployed on
Unichain** (our lead chain). See the architecture decision below.

## Goal

Close the Phase-A residual, disclosed candidly in the package README and the Phase-A
spec (invariants table, "Residual risk"): today a compromised curator MPC / Roles key can
`approve(relayer, MaxUint)` and presign a self-crafted drain order (`owner == Safe`,
`receiver == attacker`, `minOut ~ 0`), which any allowlisted solver will fill. Phase A's
presign + Zodiac Roles bound the on-chain SURFACE (which targets/selectors the curator may
call) but cannot read `receiver` / `minOut` inside the `setPreSignature` calldata. Phase B
moves those checks on-chain so no policy-failing order can ever be presigned.

Guarantee delivered: **the curator key cannot drain the vault even if it fully leaks.**

Non-goal (Phase C, not this spec): the ERC-7540 epoch/settle lifecycle, deposit/redemption
netting, Silo integration, keeper/watchtower, and `partiallyFillable == true`. This spec is
ONLY the policy module that closes the drain residual.

## Architecture decision (from the B0 research spike)

Two candidates were evaluated against real, on-chain deployment facts:

- **(A) CoW-native EIP-1271** - reuse `ExtensibleFallbackHandler` + a custom
  `ISafeSignatureVerifier` (the ComposableCoW pattern); switch the Safe from PRESIGN to the
  EIP-1271 signing scheme so `GPv2Settlement` calls `isValidSignature(digest, encodedOrder)`
  and the verifier decodes + enforces policy.
- **(B) Bespoke Safe module + PRESIGN** - a Safe module takes the full `GPv2Order.Data`,
  validates policy on-chain, computes the uid, then drives `[approve, setPreSignature]` via
  `execTransactionFromModule`. Keeps the existing PRESIGN scheme.

Per-chain viability (`eth_getCode` at the deterministic CREATE2 addresses:
`ComposableCoW 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74`,
`ExtensibleFallbackHandler 0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5`):

| Chain | (A) EIP-1271 verifier | (B) Safe module + presign |
|---|---|---|
| **Unichain (130) - LEAD** | NOT viable off-the-shelf: no EFH / ComposableCoW on-chain (empty code); would require deploying the whole Safe extensible-handler stack + verifier ourselves | Viable: depends only on `setPreSignature` (vendored, fork-tested) |
| Optimism (10) | Partial: EFH deployed, but our settlement is NON-canonical, so the canonical ComposableCoW is unusable as the verifier; bring-your-own verifier under the non-canonical domain; no watchtower | Viable, identical codepath |
| Base (8453) | Fully viable: canonical settlement + EFH + ComposableCoW + watchtower | Viable, identical codepath |

**Decision: architecture (B), one module, Unichain-first.**

1. The lead chain has none of the EFH stack, so (A) there is net-new infra to audit anyway.
2. (B) reads `settlement.domainSeparator()` and calls only `setPreSignature`, so ONE audited
   codepath works byte-identically on the non-canonical (Unichain/OP) and canonical (Base)
   settlements. No EFH deploy, no fallback-handler swap, no ComposableCoW, no watchtower.
3. (B) is continuous with Phase A: it lifts the exact `order.ts` / `guards.ts` invariants
   on-chain and keeps the PRESIGN scheme the `@ophis/safe-swap` fork tests already exercise
   on all 12 chains.

Rejected: (A) is turn-key only on Base. A hybrid (module on self-hosted, native verifier on
Base) means two policy codepaths to audit for one guarantee; rejected unless Base needs the
ComposableCoW watchtower, which it does not (the vault posts discrete orders itself).

Key mechanism note that makes (B) correct: `GPv2Signing.setPreSignature(orderUid, true)`
requires `owner == msg.sender`, and the uid embeds the Safe as owner. The module calls it
via `execTransactionFromModule`, so `msg.sender` is the Safe itself. The domain separator is
the settlement's own (`keccak256(..., chainId, address(settlement))`), which is why reading
`settlement.domainSeparator()` at runtime is both necessary and sufficient across chains.

## Module design

### Deployment model

Per-vault immutable module, minted by a minimal factory. Each instance binds at construction
(all `immutable`):

- `safe` - the vault Safe the module is enabled on.
- `settlement`, `relayer` - the chain's Ophis/CoW settlement + vault relayer (the same
  SDK-resolved addresses as Phase-A invariant 4; never a hardcoded canonical assumption).
- `curator` - the only address allowed to call `rebalance()` (the Zodiac Roles Modifier, or
  the curator key/contract).
- policy config - the token allowlist and the Chainlink feed registry (see Oracle).

The factory asserts, at deploy, that `curator` is NOT one of `safe.getOwners()` (see the
operational invariant below), and that every allowlisted token has a resolvable feed
(fail-closed).

### Interface

```solidity
function rebalance(GPv2Order.Data calldata order, uint256 minBuyOverride)
    external returns (bytes memory orderUid); // only `curator`

function cancel(bytes calldata orderUid) external; // only `curator`
```

Implementation deltas vs the first draft of this spec (each shrinks surface or
config-error room; all are in the B1 code):

- No separate `validTo` parameter - it already lives in `order.validTo` and is
  window-checked (`now < validTo <= now + maxTtl`); duplicating it added a
  consistency check with no security value.
- `relayer` and `domainSeparator` are READ FROM THE SETTLEMENT at deploy
  (both are immutables there), not passed as constructor args - the module
  cannot be wired against a mismatched relayer/domain.
- Token and feed decimals are read on-chain at deploy (`decimals()`), not
  trusted config.
- `cancel(orderUid)` added: curator-only and strictly risk-reducing (it can
  only REMOVE a presignature, never create one) - operationally needed when
  the market moves against a still-open order.
- The effective floor is `max(oracleFloor, minBuyOverride)` - the curator
  tightens, never loosens.

### Codex review hardening (2026-07-17, applied in B1)

The Codex review of PR #833 surfaced three composition attacks on the threat
model (each order valid, the AGGREGATE a drain) plus two config gaps; all
applied:

- **Daily USD turnover cap (P1).** Per-order floors alone let a compromised
  curator CHURN: alternate full-balance orders between two allowlisted
  tokens, each clearing the floor, each bleeding slippage + fees. New
  required config `dailyUsdTurnoverCap` (18-dec USD): sell-side value
  (priced by the same Chainlink read the floor used) accumulates in a UTC-day
  bucket; exceeding the cap reverts. Worst-case daily damage is now
  `cap * (maxSlippageBps + fees + intra-TTL drift)` - quantifiable per vault.
- **L2 sequencer-uptime gate (P1).** After an OP-stack sequencer outage a
  PRE-OUTAGE price can pass the staleness check before feeds recover. New
  optional config `sequencerUptimeFeed` + `sequencerGracePeriod` (must be set
  together; standard Chainlink pattern: answer != 0 = down, and reads stay
  rejected until `startedAt + grace` passes). Set it on Unichain/OP/Base
  wherever Chainlink publishes the feed; address(0) disables (with the
  documented risk).
- **Fill-time floor residual (P1) - partially structural.** The floor holds
  at PRESIGN time; a presigned order stays fillable at its signed limit until
  `validTo`, so intra-TTL adverse moves can be captured by a solver.
  Mitigated: `MAX_TTL_CAP` reduced 1 day -> **1 hour** (the builder's real
  TTL is 30 min), and the turnover cap bounds repetition. FULLY closing it
  requires enforcing the floor at settlement time via a conditional-signature
  (EIP-1271) scheme - recorded as the Phase-C extension, disclosed in the
  module NatSpec.
- **Cancel scoped to module-created uids (P2).** `rebalance` records
  `keccak256(uid)`; `cancel` refuses anything not recorded, so the curator
  cannot cancel owner-authorized presignatures that exist outside the module.
- **Zero appData rejected (P2).** `appDataHash == bytes32(0)` now fails
  construction - a zero hash would have made fee-less orders policy-valid,
  silently disabling the partner-fee invariant.
- Constructor refactored to a single `ModuleConfig` struct (11 params were
  approaching stack limits and hurting reviewability).

Additional invariants (continue the table above):

| # | Sev | Invariant | Enforced by |
|---|-----|-----------|-------------|
| B10 | CRITICAL | Sell-side USD turnover within a UTC day never exceeds `dailyUsdTurnoverCap` (churn bound) | `_recordTurnover`; unit test (2 pass / 3rd reverts / next-day resets) |
| B11 | HIGH | No oracle price is trusted while the L2 sequencer is down or within the post-recovery grace period (when a feed is configured) | `_checkSequencer`; unit tests (down / in-grace / after-grace) |
| B12 | MEDIUM | `cancel` only unsets presignatures this module created | `moduleCreatedUid` recording; unit test proves owner-created presignature untouched |

Validates (revert on ANY failure), then acts:

1. `order.sellToken`, `order.buyToken` both in the allowlist.
2. `order.receiver == safe`. (no foreign receiver - the core anti-drain check)
3. `order.feeAmount == 0`. (fee rides only in appData)
4. `order.kind == sell`; `order.partiallyFillable == false`.
5. `order.validTo == validTo` and `validTo <= block.timestamp + MAX_TTL` (local, bounded).
6. `order.buyAmount >= max(oracleFloor(sellToken, buyToken, sellAmount), minBuyOverride)`.
   `oracleFloor` = Chainlink dual-feed (StopLoss pattern). `minBuyOverride` is the curator's
   own NAV floor, required to be `>= oracle` (belt-and-suspenders; the curator can tighten,
   never loosen, the floor).
7. `order.appData == OPHIS_APPDATA_HASH` for this chain (the frozen partner-fee appData hash
   for recipient `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` at the standard bps), so the
   curator cannot strip or redirect the Ophis fee.

Then:

- Compute `uid = order.hash(settlement.domainSeparator()) ++ safe ++ validTo` (56 bytes).
- Via `execTransactionFromModule`, in order:
  a. `safe -> sellToken.approve(relayer, order.sellAmount + order.feeAmount)` - EXACT, never
     MaxUint; USDT-safe reset-to-0 first if a residual allowance exists.
  b. `safe -> settlement.setPreSignature(uid, true)` - `msg.sender == safe == owner`.
- Emit `Rebalance(uid, sellToken, buyToken, sellAmount, buyAmount)`.

There is NO other state-changing entrypoint. A module holding `execTransactionFromModule`
has full Safe power, so its ONLY door must be the policy-gated `rebalance`. This is the crux
of the whole design.

### Oracle floor (Chainlink dual-feed, StopLoss pattern)

Modeled on the CoW-audited `composable-cow/src/types/StopLoss.sol`:

- Two `AggregatorV3Interface` feeds (`sell/USD`, `buy/USD`), or a direct pair feed where one
  exists.
- `latestRoundData()`; require `price > 0` (reject invalid) and
  `updatedAt >= block.timestamp - maxStaleness` (reject stale); `scalePrice` both to 18 dp.
- `floor = sellAmount * price(sell) / price(buy) * (BPS - maxSlippageBps) / BPS`, adjusted
  for the two tokens' decimals.
- Feed registry set at construction: `(token) => feed`. Unichain Chainlink coverage is newer
  and thinner (Chainlink Scale went live on Unichain in 2026), so if an allowlisted token has
  no feed at deploy the factory reverts (fail-closed: no feed => the pair is simply not
  rebalanceable through this module).
- `convertToAssets` / `pricePerShare` is reserved for a leg that IS itself an ERC-4626 share
  (its redemption floor), with donation / spot-manipulation guards. It is the WRONG quantity
  for a plain ERC-20 <-> ERC-20 rebalance and is not used there.

### Access control and trust model

- `curator` calls `rebalance`. Even if the curator is compromised, it can trigger ONLY
  policy-valid orders, so it cannot drain (receiver pinned to `safe`, `buyAmount >= floor`).
- OPERATIONAL INVARIANT (the guarantee depends on it): the curator key MUST NOT be a Safe
  owner, and MUST be scoped (via the Phase-B Zodiac Roles preset) to call ONLY
  `module.rebalance` - never raw `setPreSignature` / `approve` on the Safe, and never
  `enableModule` / `disableModule` / `setFallbackHandler` / `setGuard`. If the curator is an
  owner or can call any of those, the module is bypassable and the guarantee is void. Enforced
  by a factory deploy-time check (`curator not in safe.getOwners()`) plus the Roles preset.
- The vault OWNER multisig (guardian / timelock) retains full authority (it can disable the
  module or rotate config). That is expected: owners are the vault's ultimate custody; Phase B
  constrains the CURATOR, not the owners.
- Module + config are immutable per instance (a new policy = a new module + owner re-enable),
  so the curator cannot widen the allowlist, swap the oracle, or raise `maxSlippage` to defeat
  the floor.

## Security invariants (enforced on-chain; unit + fuzz + fork tested)

| # | Sev | Invariant | Enforced by |
|---|-----|-----------|-------------|
| B0 | CRITICAL | `order.receiver == safe` - no foreign receiver can be presigned | `rebalance` check 2; fork drain-proof |
| B1 | CRITICAL | `order.buyAmount >= oracleFloor` (and `>= minBuyOverride >= oracleFloor`) | `rebalance` check 6 + Chainlink floor; fuzz invariant |
| B2 | CRITICAL | only `rebalance` mutates; no arbitrary `execTransactionFromModule` is reachable | module has no other entrypoint; unit selector-sweep + fuzz |
| B3 | CRITICAL | curator is not a Safe owner and is Roles-scoped to only `module.rebalance` | factory deploy check + Phase-B Roles preset; fork test |
| B4 | HIGH | `sellToken`/`buyToken` in allowlist; `feeAmount == 0`; `appData == OPHIS_APPDATA_HASH` | checks 1, 3, 7 |
| B5 | HIGH | approve is EXACT to `relayer`, never MaxUint, USDT-safe reset | module approve; unit test |
| B6 | HIGH | uid uses `settlement.domainSeparator()` (SDK-resolved settlement, per chain) | `order.hash`; golden vectors vs safe-swap TS `computeOrderUid` |
| B7 | MEDIUM | `validTo` bounded local; `kind == sell`; `partiallyFillable == false` | checks 4, 5 |
| B8 | MEDIUM | oracle feed reverts on invalid (`price <= 0`) or stale (`updatedAt` too old) | floor library; negative tests |
| B9 | MEDIUM | module + policy config immutable (curator cannot mutate allowlist/oracle/slippage) | `immutable` fields; unit test |

## Threat model

- Curator-key compromise (THE target): mitigated - only policy-valid orders are presignable.
- Oracle manipulation: Chainlink is external with staleness + validity guards and a slippage
  band; a manipulated-but-fresh feed within one heartbeat is the residual (documented) -
  mitigate with a conservative `maxSlippageBps` and `minBuyOverride` (curator NAV tightens it).
  A dual-source / TWAP check is a Phase-C option.
- Module bypass via owner-equivalent curator: prevented by the curator-not-owner factory check
  + Roles scoping (invariant B3).
- Config tampering: config is immutable per instance (invariant B9).
- Approve races / reentrancy: exact approve, USDT reset, `nonReentrant`, no external calls
  before the settlement interaction.
- setPreSignature griefing / front-run: only `curator` triggers; the uid embeds `owner==safe`,
  so no other party can presign the vault's orders.

## Components (new)

- `contracts/src/contracts/vault/OphisVaultPolicyModule.sol` - the module.
- `contracts/src/contracts/vault/OphisVaultPolicyModuleFactory.sol` - per-vault deploy +
  curator-not-owner + feed-exists asserts.
- `contracts/src/contracts/vault/OphisChainlinkFloor.sol` (library) - the StopLoss-style floor.
- `contracts/test/vault/*.t.sol` - Foundry unit + golden order/uid vectors.
- `test/fizz/**` - Echidna + Medusa stateful invariant campaign.
- `packages/safe-swap/src/roles-preset.ts` - add a Phase-B preset scoping the curator to ONLY
  `module.rebalance` (deny raw `setPreSignature` / `approve` / module-admin selectors).

No change to the vendored CoW settlement / authentication. The Ophis governance contracts
(`AllowListGuardian.sol`, `GPv2AllowListAuthentication.sol`) are orthogonal - they gate WHO
may settle, not what a vault order may be - so the validator is a new contract, not a tweak
to them.

## Test plan

- UNIT (Foundry): every invariant above; golden order/uid vectors cross-checked against the
  `@ophis/safe-swap` TS `computeOrderUid`; oracle floor math (decimals, staleness revert,
  invalid-price revert); exact/USDT approve; a selector-sweep proving no path other than
  `rebalance` mutates; config immutability.
- FUZZ (fizz - Echidna + Medusa): INVARIANT - under any sequence of calls by any caller, no
  order with `receiver != safe`, or `buyAmount < oracleFloor`, or a non-allowlisted token, or
  `feeAmount != 0` can ever reach a recorded presignature. Stateful, coverage-driven.
- FORK (Unichain first, then OP, Base): deploy a real Safe, enable the module, scope a curator
  via Roles; prove (a) a legit rebalance still produces the correct on-chain effects (exact
  allowance to the real relayer + presignature in the REAL settlement + exact pull), and
  (b) with a COMPROMISED curator key, a self-crafted drain order (attacker receiver /
  `minOut ~ 0`) REVERTS on-chain, and a raw `setPreSignature` attempt by the curator is denied
  by Roles.
- NEGATIVE: foreign receiver, tiny buyAmount, stale/zero oracle, non-allowlisted token,
  non-zero feeAmount, far-future validTo, wrong appData/fee -> all revert.

## Milestones (map to tasks B0-B5)

- B0 [this spec] - architecture + oracle decided; spec for review. Done on approval.
- B1 - implement module + factory + floor library; Foundry unit + golden vectors.
- B2 - fizz invariant campaign (drain invariants hold).
- B3 - x-ray on the new contracts + solidity-auditor (12 agents) + Codex; fix Crit/High.
- B4 - fork drain-rejection proof (compromised key cannot drain; legit still settles).
- B5 - gated Unichain deploy (EIP-55, bytecode repro), migrate the R2 trial vault to the
  module-gated scheme, re-verify; then OP, Base.

Gates before any mainnet deploy: x-ray threat model reviewed + fizz drain-invariants green +
solidity-auditor 0 Critical/High + Codex clean + fork drain-proof passing.

## Audit tooling (planned in advance, as gates - not afterthoughts)

- x-ray - threat model + invariant synthesis on the new Solidity (B3 start).
- fizz - Echidna + Medusa stateful invariant fuzzing of the drain invariants (B2).
- solidity-auditor - 12-agent adversarial audit (B3).
- Codex + ToB-semgrep + osv-scanner (over a file literally named `pnpm-lock.yaml`) +
  `git diff origin/main..HEAD --stat` before any squash - the standing discipline.

## Open decisions (for review)

1. Config: immutable-per-instance (redeploy to change) vs owner/timelock-governed mutable.
   Recommend immutable for v1 (smallest attack surface).
2. Oracle: Chainlink-only for v1, or a per-vault oracle-adapter interface so a vault can plug
   its own NAV oracle? Recommend Chainlink-only v1 + `minBuyOverride` for the curator's NAV;
   adapter is a Phase-C extension.
3. appData/fee pinning: pin the exact `bytes32` appData hash (simplest, chosen) vs decode +
   check the `partnerFee` fields on-chain (heavier). Recommend pin the hash per chain.
4. Curator-not-owner: documented operational invariant PLUS a factory deploy-time check
   (`curator not in safe.getOwners()`). Recommend the factory check (chosen above).
