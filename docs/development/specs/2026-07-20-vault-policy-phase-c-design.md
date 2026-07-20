# Ophis Vault Policy Module - Phase C: fill-time floor, oracle adapters, timelocked allowlist

Status: DRAFT (C0), **NOT ready for implementation**. Nothing here is
implemented, and the P1/P2 sections need a consolidation rewrite before C1
starts - see "Status after five review rounds" at the end. The design lanes
are sound; the document has accumulated contradictions from patching.
Owner: vault-manager feature. Prior art: `2026-07-16-vault-curator-phase-b-onchain-policy-module-design.md` (Phase B, live on 5 chains).

## Provenance / how this spec was verified

Every load-bearing external claim in this spec went through a two-stage check
before the spec was written: (1) a research pass reading the actual sources -
our vendored GPv2 contracts and `apps/backend` services subtree, fresh clones of
`cowprotocol/{contracts,services,composable-cow}`, `charlesndalton/milkman`,
`morpho-org/vault-v2`, `aera-finance/aera-contracts-public`,
`hopperlabsxyz/lagoon-v0`, `bgd-labs/aave-capo`, plus live `eth_getCode` /
`eth_call` probes on all 5 chains - and (2) an independent adversarial
verification pass that re-derived each claim from source and re-ran the on-chain
probes. Corrections found by pass 2 are already folded in; the residual list is
in "Verification log" at the end. Claims are dated 2026-07-20.

## Goal

Close the three Phase-B residuals that gate broader adoption, in order of the
guarantee they buy:

- **P1 - fill-time floor.** Today the oracle floor is enforced at PRESIGN time
  only; a presigned order stays fillable at its signed limit until `validTo`
  (bounded by `maxTtl` <= 1h). Phase C re-checks the floor at every settlement
  attempt, inside `isValidSignature`, so no fill can occur while the signed
  limit sits below the then-current oracle floor.
- **P2 - oracle adapters.** Today the allowlist admits only tokens with a
  direct Chainlink token/USD feed. Phase C introduces a small, fixed taxonomy
  of price adapters (push feeds beyond Chainlink, composed exchange-rate
  routes, bounded ERC-4626 rates, anchored pairs) so LSTs/LRTs and
  exchange-rate-quoted assets become policy-eligible without weakening the
  floor.
- **P3 - timelocked allowlist.** Today the token set is immutable at deploy;
  any change means redeploy + re-enable. Phase C makes the token set mutable
  behind an owner-proposed, guardian-vetoable timelock with instant
  risk-reducing removals - without giving the curator any admin surface.

**Non-goals (explicitly out of scope for Phase C):** partial fills, multi-order
TWAP slicing, native ETH, fee-on-transfer/rebasing tokens, non-Safe custody
(BoringVault/Mellow adapters), buy-amount-denominated orders, cross-chain
anything. Each is tracked as potential Phase D; nothing here forecloses them.

## The one-paragraph architecture

Keep the Safe as order owner and funds holder. Switch the signing scheme from
presign to **EIP-1271**: the Safe's fallback handler becomes CoW's audited
`ExtensibleFallbackHandler` (EFH), and the vault's policy module itself is
registered as the **domain verifier** for our settlement's EIP-712 domain. The
curator flow is unchanged on the surface - `module.rebalance(order,
minBuyOverride)` runs every Phase-B check once, charges the turnover bucket,
sets the exact relayer allowance, and registers the order digest - but instead
of `setPreSignature`, the order is posted to the orderbook with
`signingScheme: eip1271`. From then on, **every** validation of the order (at
placement, in every driver simulation, and inside the settlement transaction
itself) staticcalls back into the module, which re-checks the time-varying
policy - oracle cross-rate floor, staleness, sequencer gate, allowlist
membership, cancellation state - against live chain state. A stale order does
not fill; if price recovers within the TTL it becomes fillable again; at
`validTo` it dies. Funds never leave the Safe. Presign mode remains available
as a per-vault deployment choice.

## Why this shape (decisions + ruled-out alternatives)

### P1 lane: EFH + module-as-verifier (the ComposableCoW pattern, minus ComposableCoW)

The settlement side needs nothing new: our vendored `GPv2Signing` (byte-identical
to upstream `cowprotocol/contracts` @ ff07c4a0) already supports scheme
`Eip1271` - `recoverEip1271Signer(orderDigest, signature)` slices a 20-byte
owner prefix and STATICCALLs
`isValidSignature(bytes32 orderDigest, bytes signature)` on the owner, requiring
magic `0x1626ba7e` (`GPv2Signing.sol:281-303`). The order owner must be the
Safe (the vault relayer pulls sell tokens from the owner), so the 1271 answer
must come from the Safe - which means a fallback-handler route. Verified facts
that fix the lane:

- **EFH is deployed at `0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5` on
  Ethereum, Optimism, Base, Arbitrum** (identical 9,419-byte runtime, verified
  by `eth_getCode` on all four) and **absent on Unichain** (0 bytes). It is
  audited (Ackee Blockchain 2023, report 1.2; Gnosis internal May/Jul 2023 +
  diff audit Aug 2024) and has validated CoW TWAP fills in production since
  Aug 2023 through exactly this call path.
- **Unichain gets the same address by replaying the original deployment**: the
  canonical CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` is
  live on Unichain; replaying the original mainnet deploy calldata (salt
  `bytes32("v1.0.0")` + the original 9,451-byte initcode, preserved from
  mainnet tx `0x33dcbc73a8797c69a5b3956539dd8d191cf3f190bcb27a4d4eca8556f030f574`)
  reproduces `0x2f55...5bF5` exactly (recomputed via `cast create2`). Do NOT
  rebuild from source - composable-cow issue #93 confirms current source does
  not reproduce the deployed bytecode (metadata drift).
- **ComposableCoW itself is ruled out**, twice over: we don't need its
  conditional-order registry or the Watchtower (our own pipeline posts orders;
  Watchtower only matters for autonomous order creation), and the instances
  deployed on OP/Base are constructor-bound to the **canonical** settlement's
  domain separator (`0x8b0a8cfa...` on OP = canonical `0x9008D19f...` domain),
  so they cannot validate orders for our sovereign settlements anyway. EFH
  itself is settlement-agnostic: `setDomainVerifier` keys verifiers per
  `(safe, domainSeparator)`.
- **Milkman's escrow lane is ruled out**: it moves funds out of the Safe into a
  per-order clone with a max relayer approval - against our custody story - and
  its shipped Chainlink checker has no staleness check. We keep its one good
  idea (fill-time price check inside `isValidSignature`) without the escrow.
- **A custom fallback handler is ruled out**: it would forfeit EFH's audit
  history and production track record to save ~40 lines, with the identical
  Safe-UI "non-default handler" warning either way.

The verifier is **the module itself**. EFH's muxer interface is
`isValidSafeSignature(Safe safe, address sender, bytes32 _hash, bytes32
domainSeparator, bytes32 typeHash, bytes encodeData, bytes payload) external
view returns (bytes4)` - the module (already one-per-vault, already holding all
policy state) implements it directly. One less contract, one less trust edge.
Before delegating, EFH re-derives
`keccak256(0x19 || 0x01 || domainSeparator || keccak256(typeHash || encodeData))`
and delegates to the verifier ONLY if it equals `_hash` - so the module
provably receives the exact order struct that hashes to the digest being
settled, and never trusts decoded fields it didn't bind. (Mechanism note for
the C1 tests: on mismatch EFH does not `require`; it falls through to
`defaultIsValidSignature`, the owner-threshold path, which then reverts for
our blob. Same security outcome, different revert - assert the behaviour, not
a specific `require`.)

### P2 lane: fixed adapter taxonomy, price18-shaped

Our floor math (`OphisChainlinkFloor.floorBuyAmount`, audited through Phase B)
consumes two 18-decimal USD prices. P2 keeps that contract and swaps the feed
read for an adapter read. A generic plugin bus is ruled out (unbounded audit
surface); instead a fixed taxonomy of four immutable adapter types, chosen
against the verified per-chain feed reality (full catalog in "Oracle ground
truth" below):

1. **PushFeedAdapter** - AggregatorV3-shaped read with per-source
   `{proxy, decimals-read-at-deploy, maxStaleness}`. One code path covers
   Chainlink, RedStone push (verified AggregatorV3-compatible, 8-dec, constant
   `roundId=1`), and API3 `Api3ReaderProxyV1` (verified `(0, answer, ts, ts,
   0)`; `getRoundData` reverts). The `answeredInRound < roundId` completeness
   check is **Chainlink-only** (constructor flag): RedStone/API3 pass it
   vacuously or with meaningless semantics.
2. **ComposedRateAdapter** - exchange-rate push feed x underlying
   `IOphisPriceSource` (e.g. Unichain wstETH: `wstETH/stETH ExR (0x1f31C00A...)
   x ETH/USD (0xBcE70e19...)`), per-leg staleness. This is Chainlink's own
   documented recommendation for yield-bearing assets and Morpho's
   `MorphoChainlinkOracleV2` composition math is the reference.
3. **Erc4626RateAdapter** - `convertToAssets`-derived rate x underlying
   adapter. **NOT ELIGIBLE AS A FILL-TIME SOURCE (P1) - registration-time
   only, and only in Presign mode**, because the fill-time check runs INSIDE
   the settlement transaction, AFTER solver-controlled pre-interactions: a
   settling solver can deposit/donate into the referenced 4626 vault in the
   same transaction, move `convertToAssets`, and bend the floor down before
   `isValidSignature` reads it. That defeats P1's entire guarantee for any
   source whose value is a function of mutable live contract state the solver
   can touch in-tx. See "Adapter eligibility" below - this constraint governs
   the whole taxonomy, not just this type.
   Where it IS used, it is legal only wrapped in bounds: a CAPO-style snapshot
   + max-yearly-growth upside cap (Aave `PriceCapAdapterBase` formula: cap =
   snapshotRatio + snapshotRatio * maxYearly% * elapsed / year, snapshot term
   <= 180 days) **plus a lower bound that itself grows with the snapshot** (a
   static lower bound decays to a no-op against a monotonically growing rate,
   erasing sell-side deflation protection over time). Raw `convertToAssets` is
   banned:
   the Venus wUSDM donation attack (2025-02-27, rate 1.0694 -> 1.7641 in one
   step, net loss $716,789) is exactly the drain our floor exists to prevent,
   and for OUR floor both directions are dangerous - an inflated BUY-token rate
   *lowers* the floor (vault overpays), a deflated SELL-token rate also lowers
   it. CAPO alone is upside-only; we cap both sides.
4. **AnchoredAdapter** - wraps a primary source with an independent anchor and
   a `maxDivergenceBps` band, enforced in BOTH directions and fail-closed.
   Reference points for sizing (stated precisely, because the shapes differ):
   Liquity v2 uses 1% for stETH/USD-vs-ETH/USD and 2% for rETH
   market-vs-canonical - both are LST peg checks, and both act as *selection*
   switches on redemption rather than fail-closed bands, so they inform the
   magnitude only, not the semantics; Cove's audited AnchoredOracle is the
   fail-closed-band precedent and bounds the parameter to [0.1%, 50%] (we
   reimplement the pattern - their code is BUSL-1.1). Liquity has no
   stables/majors threshold to borrow; ours for stables is a
   Phase-C parameter choice to be set per route, not an inherited
   figure. Mandatory for RATE-class sources and for exchange-rate feeds
   used on the buy side, because **exchange-rate feeds do not track market
   depegs** - wstETH/stETH ExR stays ~1.24 even if stETH trades at 0.9 ETH; the
   fail-open case is buying a depegged asset at par. Anchor independence
   matters: on Unichain, Chainlink's wstETH ExR and Chronicle's are bit-identical
   (same upstream `getPooledEthByShares`) - NOT independent; RedStone's
   wstETH/ETH market feed is the genuinely independent leg.

**Ruled out as floor primaries:** Pyth (pull model: freshness depends on
third-party keepers pushing; `updatePriceFeeds` is state-mutating and cannot run
in the 1271 view context; Euler caps Pyth staleness at 15 min - frequently dead
on quiet chains), RedStone Core pull (state-mutating `updatePrice` cache),
Chronicle (reads are toll-whitelisted; `address(0)` is tolled so off-chain
simulations pass while the on-chain caller reverts - a testing trap; usable
later as an anchor if we accept the whitelist ops dependency), and TWAP-of-rate
(not a mainstream production mitigation; snapshot+growth-cap and anchor bands
dominate).

Adapters must be **staticcall-pure**: any adapter that internally mutates state
reverts the whole settlement at fill time despite passing unit tests via
`eth_call`. Every adapter is liveness-probed at registration exactly like
Phase-B probes feeds today.

**Adapter eligibility (the constraint that makes P1 real).** Staticcall-purity
is necessary but NOT sufficient. `isValidSignature` executes inside the
settlement transaction, after the solver's own pre-interactions have run, so a
source that merely *reads* mutable state the solver can write in the same
transaction is manipulable exactly at the moment the floor is supposed to bind.
Sources are therefore classified once, at registration, and only one class may
gate fills:

- **FILL-ELIGIBLE**: values whose ON-CHAIN WRITE PATH is gated by an
  allowlist of privileged writers, so no settlement participant can move them
  mid-transaction. **This is a property of the specific FEED, decided by its
  write authorization - never of a vendor brand.** Verified 2026-07-20:
  Chainlink OCR aggregators qualify - `transmit` is transmitter-allowlisted AND
  EOA-only (`msg.sender == tx.origin`), hence unreachable from the settlement
  contract; a differential `eth_call` on Unichain returns
  `UnauthorizedTransmitter()` from an arbitrary sender versus
  `WrongNumberOfSignatures()` from the registered transmitter.
  **RedStone push and API3 DO NOT qualify** and must not be treated as
  fill-eligible: both use a sign-off-chain / anyone-relays model.
  `MultiFeedAdapterWithoutRounds.updateDataFeedsValuesPartial` is `public` with
  no caller check (`requireAuthorisedUpdater` defaults to an empty body -
  "By default, anyone can update data feed values"), accepts payloads up to
  ~3 minutes old with no deviation bound, and skips failed updates silently so
  the attempt is free; `Api3ServerV1.updateBeaconWithSignedData` is `external`
  guarded only by `recover(signature) == airnode`, with a future-side timestamp
  bound only - permissionless in-transaction updating is API3's stated design
  intent (it is the basis of their OEV product). Independently reproduced: the
  RedStone Unichain adapter returns `CalldataMustHaveValidPayload()` from two
  unrelated senders, i.e. execution reaches payload parsing with no
  authorization step. Chronicle `poke` and Pyth `updatePriceFeeds` fail the
  same test.
- **REGISTRATION-ONLY**: values derived from live protocol state readable and
  writable in-tx - ERC-4626 `convertToAssets`, `getPooledEthByShares`, AMM
  spot, any `IRateProvider` backed by mutable balances. These may tighten the
  floor at `rebalance` time (where the curator, not a solver, controls the
  transaction) but MUST NOT be consulted at fill time.

A route whose sources are not all FILL-ELIGIBLE cannot be used by a vault in
Eip1271 mode; the module rejects such a registration rather than silently
degrading the guarantee. **Eligibility must be rooted in the FEED, and codehash pinning cannot do it.**
Two earlier attempts were wrong and are recorded here so they are not retried.
(1) Adapter self-declaration (`fillEligible`) is a claim by the very contract
whose trustworthiness is in question. (2) Pinning adapter `extcodehash` fails
twice over: Solidity inlines `immutable` values into runtime bytecode, so two
PushFeedAdapter instances differing only in their `{proxy, decimals,
maxStaleness}` configuration have DIFFERENT codehashes and no fixed pin can
admit the family; and more fundamentally, fill-eligibility is a property of the
CONFIGURED FEED ADDRESS an adapter points at, not of the adapter's code - the
same audited bytecode is eligible or not depending on its `proxy` field, so no
codehash scheme can decide the question.
The eligibility decision therefore lives where the property does: **an explicit
per-chain allowlist of FEED ADDRESSES whose write path has been verified
privileged-writer-gated**, recorded in the module and extended only through the
P3 timelock, where the claim "this feed's `transmit` is transmitter-allowlisted"
is exactly the kind of assertion a public delay window exists to let reviewers
check. A composed route is fill-eligible only if every leg's feed address is on
that list. `sourceKind()` survives as a cross-check and a source of clear revert
reasons, never as the authority. This is a real coverage cost - it removes exactly the
LST/LRT rate composition that motivated P2 for some pairs - and the honest
resolution is that those pairs get an ExR *push feed* (which Chainlink,
RedStone and API3 all publish for the major LSTs, per the catalog above) rather
than an on-chain rate read. Where no push feed exists, the vault runs that pair
in Presign mode with a registration-time floor, and the spec says so plainly
instead of claiming a fill-time guarantee it cannot deliver.

### P3 lane: in-module pending map, Safe-proposed, guardian-vetoable

This ports the `AllowListGuardian` pattern - our chain-governance
timelock+guardian split (timelocked adds, instant risk-reducing removals),
live on OP and Unichain since June and on-chain-verified (24h
`TimelockController`, deployer admin renounced, Safe-only proposer/executor;
note it governs the solver allowlist and is otherwise orthogonal to the vault
module) - into the module, hardened with the best mechanics found in the
field:

- **Proposer = the vault Safe, never the curator.** Morpho V2 lets the curator
  propose because depositors can exit in-kind during the delay; our vault has
  no third-party exit - the Safe owners ARE the depositors. A curator that can
  propose defeats the headline guarantee with patience. The curator gets ZERO
  admin surface: cannot propose, cannot execute, cannot cancel, cannot remove.
- **Atomic payload**: a token and its full oracle route (adapter address,
  staleness, anchor config) are one `TokenAdd` struct, hashed as the pending
  key (Morpho keys pendings by full calldata). A token must never be allowed
  with unset oracle config for even one block. Changing an existing token's
  oracle route is exactly as dangerous as an add and takes the identical path
  (instant remove + timelocked add).
- **Validate at execute, not only at submit.** Morpho validates nothing at
  submit and documents the footgun; Aera probes at schedule AND commit.
  `executeTokenAdd` re-runs constructor-grade validation: duplicate-reject,
  decimals <= 36, staleness bounds, live adapter probe, sequencer gate, and
  `allowedTokens.length < MAX_ALLOWED_TOKENS` (the cap that keeps
  `removeToken`'s sweep statically bounded - see C15).
  **A liveness probe is not identity validation.** "The adapter returned a
  nonzero number" cannot distinguish a token/USD price from an exchange rate,
  a decimals-mismatched proxy, a deliberately capped TEST feed (Unichain ships
  a live 8-decimal `USDC / USD TEST CAPPED` proxy - see the catalog), or a
  constant. Any of those silently collapses the floor in the direction that
  lets value leave. Registration therefore also requires: the source's
  self-declared `sourceKind`/`fillEligible` to match the route's intent; the
  returned price to sit inside an explicit per-token sanity band supplied in
  the `TokenAdd` payload (so the proposer states what "right" looks like and
  the timelock makes that claim publicly reviewable); and, for Eip1271-mode
  vaults, every source in the route to be FILL-ELIGIBLE.
- **Pendings expire, and execution is NOT permissionless.** Morpho, OZ
  TimelockController, and Aera pendings live forever and execute
  permissionless-after-delay - a forgotten pending add is a landmine anyone
  (including a compromised curator) can detonate months later. We deviate
  deliberately on both axes: **`executeTokenAdd` is callable only by the Safe**
  - explicitly NOT by the guardian. An earlier draft allowed Safe-or-guardian
  "for timing", which was wrong: execution is what actually widens the token
  set, so a guardian that can execute holds additive power, falsifying C10 and
  inverting the AllowListGuardian precedent this design cites (there the Safe
  is sole proposer AND executor, and the guardian's only power is the
  risk-reducing `removeSolver`). The guardian's authority here is exactly
  cancel-pending and remove-token; it can never cause a token to become
  allowed. Execution is also only possible within
  `[submittedAt + DELAY, submittedAt + DELAY + EXECUTE_WINDOW]` (Zodiac
  Delay's expiry idea) - without adopting Zodiac's FIFO (head-of-line
  blocking; and its cooldown/expiration are owner-mutable instantly, which
  independently argues for our immutable constructor delay). Keyed independent
  pendings like Morpho/Aera.
- **Veto covers the whole delay and is multi-party**: `cancelPending` is
  instant for guardian OR Safe. **Removals are instant** for guardian OR Safe
  (capability-reducing needs no delay - Morpho sentinel pattern; the guardian
  gets no additive power, matching our AllowListGuardian doc: an additive
  escape hatch "would defeat the timelock").
- **`DELAY` (>= 24h) and `EXECUTE_WINDOW` are immutable constructor params.**
  Morpho's mutable per-selector delays create the documented
  pending-`decreaseTimelock` pipelining hole where the real guarantee horizon
  is a `min()` over pendings; with ~3 admin ops, per-selector granularity buys
  nothing.
- **Removal atomically settles the live-order residual, on BOTH sides - via
  bounded per-sell-token slots, never an append-only index.** Phase-B
  bookkeeping is keyed by sell token only, so a live order whose BUY side is
  the removed token would survive removal. The naive fix - a
  `token => uid[]` index appended at registration - is WRONG and must not be
  built: **nothing can prune it on the two most common terminal states.** A
  fill is observed only inside `isValidSignature`, which is a STATICCALL and
  cannot write; a passive expiry has no transaction at all. So such an index
  is append-only in practice, grows one entry per historical rebalance, and
  makes `removeToken` iterate every dead uid - eventually exceeding the block
  gas limit and reverting. That would let a compromised curator **brick the
  guardian's instant-removal power** by spamming registrations: a curator
  degrading a safety control, which is exactly the escalation this module
  exists to prevent.
  Phase C instead extends the **existing per-sell-token live slot** (Phase B's
  `liveAllowanceUid` / `liveAllowanceOrderUid`, already invariant-tested at
  `<= 1 live order per sell token`) into
  `liveOrder[sellToken] = {bytes uid, address buyToken, bytes32 digest}`.
  Storage is O(allowlist), self-overwriting on supersede, and retains no
  history. `removeToken(token)` iterates `allowedTokens` - length-capped at
  `MAX_ALLOWED_TOKENS` so the sweep is statically bounded - and for each sell
  token `S` with a live record `R`, revokes `R` when `S == token` OR
  `R.buyToken == token`, then zeroes `S`'s relayer allowance when the revoked
  order still owned it (the existing `cancel()` ownership rule, refactored
  into a shared internal path). Worst case is one settlement call per
  allowlisted token, bounded at deploy.
  **The sweep must be revert-tolerant, not all-or-nothing.** Every step is an
  external call through the Safe - `approve` on an arbitrary allowlisted ERC20
  and `setPreSignature`/`invalidateOrder` on the settlement. A pausable or
  blacklisting token whose `approve` reverts would, under an atomic sweep,
  brick `removeToken` entirely: the guardian could not remove the very token
  that just went rogue, and one bad token would also block removal of every
  unrelated token. That is the emergency the function exists for, so it must
  not be the case that fails. Normatively: **de-allowlisting is applied to
  storage FIRST and unconditionally** (the policy effect that stops new
  registrations and, in Eip1271 mode, instantly invalidates outstanding
  orders via the fill-time allowlist re-check), and each residual revocation
  is then attempted independently with its failure isolated
  (`try`/`catch` per call), emitting `ResidualRevocationFailed(token, uid,
  reason)` rather than reverting the transaction, and the failure is deferred
  to a retryable `sweepResidual(token)`. C15 must bound reverts, not just gas.
  **But revert-tolerance and the removal guarantee conflict in Presign mode,
  and the conflict must be resolved by mode, not waved away.** In Eip1271 mode
  de-allowlisting IS the enforcement: the fill-time allowlist re-check refuses
  the order at the next settlement attempt, so catching a failed
  `setPreSignature(uid, false)` is genuinely safe and only allowance hygiene is
  deferred. In Presign mode there is no fill-time gate - the settlement's
  `preSignature` mapping is independent of our storage, so a swallowed
  revocation failure leaves the order STILL FILLABLE at its old floor with a
  live allowance. Therefore residual steps are classified:
  **policy-critical** (`setPreSignature(uid, false)` in Presign mode) MUST
  succeed or the whole `removeToken` reverts; **hygiene**
  (allowance zeroing, and revocation in Eip1271 mode where the policy effect
  already landed) is failure-isolated and retryable.
  **Correction to an earlier draft of this section:** it claimed a freezable
  ERC20 could brick the policy-critical step and that Presign allowlists must
  therefore exclude such tokens. That is false. `setPreSignature` and
  `invalidateOrder` are calls to the SETTLEMENT with zero token interaction -
  `extractOrderUidParams`, an owner check, one storage write, one event
  (`GPv2Signing.sol:321-331`) - so no token can make them revert. Only the
  ALLOWANCE step touches the token, and that step is hygiene, not policy. The
  listing rule is withdrawn.
  This also resolves the C15 tension: because the policy-critical call cannot
  be made to fail by any token, `removeToken` never needs to revert on a
  hostile token, and de-allowlisting genuinely is unconditional. The remaining
  honest caveat is narrower - if the settlement call fails for some other
  reason in Presign mode there is no fill-time gate to fall back on, so that
  case reverts by design.
- **The record stores the full uid BYTES, not just the digest.** A GPv2 uid is
  `digest(32) || owner(20) || validTo(4)`; `validTo` is hashed *into* the
  digest but is not recoverable *from* it, so neither
  `setPreSignature(uid, false)` nor `settlement.invalidateOrder(uid)` can be
  called from a digest alone. This is the same lesson Phase B already encodes
  (`liveAllowanceOrderUid` exists precisely because "`setPreSignature` needs
  the uid bytes, not just their hash" - module NatSpec); Phase C keeps that
  property and adds `buyToken` beside it. A digest-keyed design would leave
  buy-side orders un-revocable in presign mode.
- Revocation is mode-aware: presign mode `setPreSignature(uid, false)`, 1271
  mode `settlement.invalidateOrder(uid)`. In 1271 mode the fill-time allowlist
  re-check (both sides) makes removal *instantly* invalidating even before the
  on-chain revoke lands - a P1xP3 synergy; in presign mode the on-chain revoke
  IS the enforcement, which is why it must cover the buy side too.
- **Frozen mode stays available**: a factory flag deploys Phase-B semantics
  (no pending map, token set fixed at deploy) for vaults that want the
  strongest static story. Default is timelocked.

**Ruled out:** curator-as-proposer in any form; reusing the chain-level Ophis
TimelockController as a vault's proposer (wrong trust root - it would make
Ophis governance the custodian and kill the drain-proof claim); an external
Zodiac Delay in front of the Safe (FIFO blocking + a second enabled module);
mutable or per-selector delays; unexpiring pendings; any shared Ophis-governed
registry as sole authority (acceptable later only as an additional
AND-constraint, Morpho `adapterRegistry`-style).

## Order lifecycle (1271 mode, end to end)

1. **Registration (state-changing, curator tx).**
   `module.rebalance(order, minBuyOverride)`:
   - all Phase-B checks unchanged (allowlist both sides, receiver == Safe,
     `feeAmount == 0`, pinned `appDataHash`, KIND_SELL / fill-or-kill /
     ERC20 balances, `validTo` within `maxTtl`, sequencer gate, oracle floor
     with adapter reads, `ZeroOracleFloor` guard, leaky-bucket turnover charge);
   - **wiring assertion (new, fail-closed)**: the Safe's fallback handler slot
     (`safe.getStorageAt(FALLBACK_HANDLER_STORAGE_SLOT, 1)`, available on Safe
     >= 1.3.0 via StorageAccessible) must equal the pinned EFH address, and
     `EFH.domainVerifiers(safe, domainSeparator)` must equal this module -
     otherwise the posted order could silently fall through to owner-threshold
     validation;
   - registers `orderState[digest] = Registered{sellToken, buyToken, validTo,
     registeredAt, minBuyOverride, sellUsd18}`. `validTo` is STORED, not
     re-derived from caller input later: it is the refund time gate and it is
     needed to rebuild the uid, and taking either from caller-supplied bytes is
     the CRITICAL defect fixed in this document. (The fill-time path may still
     read `validTo` out of `encodeData`, because there EFH has already proven
     that struct hashes to the settled digest.)
   - supersession unchanged in spirit: a same-sell-token predecessor is
     deregistered AND hard-invalidated (`invalidateOrder(uid)` via
     `execTransactionFromModule`) before the allowance is repointed;
   - sets the exact relayer allowance (existing `_approveAndPresign` logic
     minus the presign call).
2. **Placement (off-chain).** safe-swap posts the order with
   `signingScheme: "eip1271"`, `from: safe`, and
   `signature = abi.encodeWithSelector(0x5fd7e97d /* safeSignature(bytes32,bytes32,bytes,bytes) */,
   domainSeparator, GPv2Order.TYPE_HASH, abi.encode(order), bytes(""))`.
   The API `signature` field is the raw bytes; the settlement encoding
   (`owner(20) || bytes`) is added by the protocol. Our orderbook validates at
   creation (`eip1271-skip-creation-validation = false` on both sovereign
   chains, flipped by audit MEDIUM-6) by simulating the full verification via
   the deployed `Signatures` support contract (`0x5f315A20...2fac` on OP and
   Unichain), measuring the real verification gas and pricing it into the
   quote (default assumption 27k gas; `max-gas-per-order` 8M default). A
   floor-failing order is rejected at the door with
   `InvalidEip1271Signature` - the builder must surface this distinctly.
3. **Every validation thereafter.** EFH re-derives the digest from
   `(domainSeparator, typeHash, encodeData)` and delegates to
   `module.isValidSafeSignature(...)` (STATICCALL - no state writes possible).
   The module:
   - requires `safe_ == address(safe)` and
     `domainSeparator_ == this.domainSeparator`; `sender` and `payload` are
     ignored for authorization (settlement context is adversarial: the
     Feb-2023 Barter incident drained fees via settlement-context calls;
     `msg.sender == settlement` is never authority). The `safe_` pin closes
     the foreign-Safe edge: `EFH.domainVerifiers` is caller-scoped, so any
     other Safe could register this module as its verifier - harmless today
     (every registered digest pins `receiver == our safe`, so a foreign owner
     could only spend its own funds to our benefit) but cheap to exclude
     outright rather than rely on an implicit argument;
   - decodes `GPv2Order.Data` from `encodeData`, requires
     `orderState[_hash]` is `Registered` (payload-authenticity: the digest
     binding is EFH's job, the registration binding is ours - without it,
     anyone could post policy-passing orders for the Safe);
   - re-runs the **time-varying** checks against live state:
     `validTo >= block.timestamp`, sell+buy tokens still allowed (P3 removal
     => instant invalidity), sequencer gate, adapter reads with staleness, and
     `order.buyAmount >= max(freshOracleFloor, storedMinBuyOverride)`;
   - returns `0x1626ba7e` on success; on failure reverts with **typed
     reasons** split transient vs fatal (`FloorNotMet`, `StaleOraclePrice`,
     `SequencerStarting` = transient; `OrderNotRegistered`, `TokenNotAllowed`,
     `Expired` = fatal), mirroring ComposableCoW's
     `OrderNotValid`/`PollTryNextBlock` taxonomy so tooling can distinguish.
   - Checks frozen in the digest (receiver, appData, flags, amounts, kind) are
     NOT re-run - they cannot change - except the allowlist, re-checked for the
     P3 synergy.
4. **Fill.** `partiallyFillable = false` is kept: exactly one fill, floor
   evaluated at the real fill, `filledAmount[uid]` marks the uid replay-safe
   forever. The guarantee, stated precisely: *no fill can occur while the
   signed limit (`buyAmount`) is below the current oracle floor; the settlement
   itself enforces executed >= signed limit.* (The verifier cannot see the
   executed amount - 1271 gates order validity, not the clearing price; solver
   competition prices the fill above the limit.)
5. **No fill / floor breach.** Post-placement, nothing in the orderbook removes
   the order: autopilot's periodic 1271 re-validation was REMOVED upstream
   (services #4118, merged 2026-02-12, included in our pin) and balance checks
   are skipped for 1271 orders - the order stays in every auction until
   `validTo` and is dropped per-attempt by driver simulation
   (`resimulate_until_revert` re-simulates on every new block, so a
   mid-auction floor flip is caught pre-submission - no on-chain revert). This
   is graceful degradation: if price recovers within TTL the order fills;
   otherwise it dies at `validTo`. Two consequences the spec accepts and
   documents: (a) near-floor orders oscillate valid/invalid and burn solver
   simulation cycles - the builder MUST quote a buffer above the floor
   (existing slippage math already does; the runbook rule
   `slippageBps + fee + quote-vs-oracle gap < 50bps` carries over); (b) on
   CoW-hosted chains (Eth/Base/Arb) third-party solvers may deprioritize
   revert-prone orders with their own heuristics - the reference driver's
   bad-order detector is entirely OFF by default
   (`enable-metrics-bad-order-detection = false`) and our sovereign driver
   sets none of its knobs, but hosted-chain solver behavior is not ours
   to control.
6. **Cancellation.** The API `DELETE /orders` route is structurally impossible
   for Safe-owned orders (cancellation signatures are ECDSA-only in the
   services model). `module.cancel(digest)` therefore: deregisters (=>
   verifier reverts from the next staticcall on) AND hard-cancels on-chain via
   `execTransactionFromModule -> settlement.invalidateOrder(uid)`
   (owner-only from the uid, sets `filledAmount = uint256.max`, emits
   `OrderInvalidated` which the autopilot indexes into the `invalidations`
   table => permanent removal from auctions, API status `cancelled`), and
   zeroes the allowance under the existing `liveAllowanceUid` ownership rules.
   Cancel stays curator-callable (strictly risk-reducing) and is also invoked
   by the P3 `removeToken` path.
7. **Turnover refund (new decision, and its test MUST be time-gated).** The
   bucket is charged at registration for orders that may never fill; a
   compromised curator could otherwise exhaust the day's budget with
   never-fillable registrations (DoS on rebalancing, not a drain). `cancel`
   refunds the order's charged `sellUsd18` only when BOTH hold:
   `block.timestamp <= state.validTo` (read from STORED `OrderState`, never
   from caller input) AND `settlement.filledAmount(uid) == 0` for the uid the
   module REBUILDS itself, read BEFORE invalidating (which sets it to
   `type(uint256).max`).
   **The `validTo` gate is load-bearing, not cosmetic.**
   `filledAmount(uid) == 0` is NOT a sound "never filled" test once an order
   has expired: `GPv2Settlement.freeFilledAmountStorage(bytes[])` resets
   `filledAmount[uid] = 0` for any uid with `validTo < block.timestamp`
   (`GPv2Settlement.sol:262-266` -> `freeOrderStorage:474-487`), and its only
   guard is `onlyInteraction` (`address(this) == msg.sender`, line 94-97) - so
   ANY solver can zero it by putting the call in a settlement's interaction
   list, with no owner check and no per-order authorization. Without the time
   gate the attack is: register (bucket charged) -> order FILLS -> order
   expires (<= 1h) -> any solver frees the slot -> curator calls `cancel` (the
   Phase-B registration record survives both fill and expiry) -> reads
   `filledAmount == 0` -> refund granted for an order that actually settled.
   Repeated each TTL window, that lets a compromised curator settle many
   multiples of `dailyUsdTurnoverCap` per day - the refund would unbind the
   headline economic bound it sits next to. Inside the validity window
   `freeFilledAmountStorage` cannot have run (it requires `validTo <` now), so
   there `filledAmount == 0` is trustworthy.
   **CRITICAL PREREQUISITE - never read a policy input out of a caller-supplied
   uid.** `GPv2Order.extractOrderUidParams` is a pure calldata slice whose only
   guard is `orderUid.length == 56` (`GPv2Order.sol:226-242`); `filledAmount`
   and `preSignature` are both `mapping(bytes => uint256)` keyed on the RAW uid
   bytes (`GPv2Settlement.sol:47`, `GPv2Signing.sol:57`); and
   `invalidateOrder`/`setPreSignature` authorize only on the owner slice
   `uid[32:52]`. So a `cancel(bytes orderUid)` against digest-keyed state
   authenticates just 32 of 56 bytes, and BOTH refund gates then read the
   unauthenticated tail: forging the 4 `validTo` bytes simultaneously satisfies
   `block.timestamp <= validTo` AND re-keys `filledAmount` to a virgin slot
   reading 0 - refunding an order that actually filled, repeatably, which
   unbinds `dailyUsdTurnoverCap` entirely. Presign mode is worse still: the
   forged uid revokes a nonexistent presignature while the real order stays
   PRE_SIGNED and fillable. Phase B is immune only because its `cancel` keys on
   `keccak256(orderUid)` over all 56 bytes.
   Therefore, normatively: **`cancel` takes `bytes32 digest`**, `OrderState`
   stores `uint32 validTo`, and the module REBUILDS the uid internally with
   `GPv2Order.packOrderUidParams(buf, digest, address(safe), state.validTo)`,
   so the time gate, the `filledAmount` key and the
   `invalidateOrder`/`setPreSignature` argument are all module-derived. Any
   future `bytes` overload must compare against the stored uid BEFORE
   evaluating a gate. Required negative test (Phase B has its analogue at
   `OphisVaultPolicyModule.t.sol:564,631`): a cancel whose uid tail differs
   from the registered order must revert.
   Refunds are one-shot by construction (Phase-B `cancel` deletes the
   registration record before interacting, so the path cannot be re-entered)
   and never credit more than was charged. No refund on passive expiry - which
   the `validTo` gate now ENFORCES rather than merely intends; a curator who
   wants the budget back must cancel before expiry.

## Oracle ground truth (verified 2026-07-20, drives the P2 catalog)

- **Unichain**: 12 Chainlink RDD entries, but NOT uniformly shaped - 10 price
  feeds at 18 decimals with 24h heartbeats, PLUS a 0-decimal sequencer-uptime
  feed and an 8-decimal `USDC / USD TEST CAPPED` proxy
  (`0x3d16af379E134DF160313411c970e2BeEECAb73E`) which is LIVE and updating
  (so there are effectively THREE live USDC/USD-named proxies, only two of
  which are production). This is precisely why routes pin exact addresses and
  read `decimals()` at registration rather than assuming a per-chain norm. The
  10 production feeds -
  ETH/USD `0xBcE70e19...` (0.5% dev), BTC/USD, LINK/USD, UNI/USD, two
  production USDC/USD proxies (`0xbd1cD151...` and `0x7E014561...` - pin by
  address, never resolve by symbol, and never confuse them with the TEST
  CAPPED proxy above), and exchange-rate feeds wstETH/stETH
  `0x1f31C00A...`, weETH/eETH `0xc47e4a32...`, ezETH/ETH, rsETH/ETH (all
  0.05% dev). Separately, the sequencer-uptime feed `0x495639D9...` (verified
  live, 0 decimals - it is a status flag, not a price, and is read by the
  sequencer gate rather than by any adapter).
  NO USDT/USD (RedStone `0x58fa68A3...` is the only push option), no
  stETH/USD, no LST market feeds - wstETH->USD requires the ExR x ETH/USD
  composition (peg assumption) anchored by RedStone's wstETH/ETH market feed
  (`0x24c89643...`), which is the independent leg.
- **OP/Base/Arb/Ethereum**: rich Chainlink coverage incl. market + ExR feed
  pairs for wstETH/rETH/weETH/cbETH/ezETH/rsETH and sUSDe (full addresses in
  the research digest; each goes through the same pin-by-address + on-chain
  re-probe discipline at deploy). Decimals are 8 for USD feeds and 18 for
  ETH-quoted feeds on these chains - adapters read `decimals()` at deploy,
  never assume.
- **Feed churn is real, and announcements are not shutdowns**: Chainlink flags
  feeds `deprecating` with ~2-week notice (Arbitrum ETHx/ETH ExR
  `0x1f5C0C2C...` was announced for 2025-12-22 and is STILL publishing as of
  2026-07-20, ~11h fresh; stBTC/BTC ExR + ezETH PoR are announced for
  2026-07-22). Operational rule: route replacement triggers on the RDD
  `deprecating` flag, not on observed liveness - a still-publishing
  deprecated feed is exactly the trap. This is why P3
  covers oracle-route replacement, not just token add/remove, and why per-token
  `maxStaleness` must be sized to the feed's heartbeat + margin. Live-module
  reality check (on-chain-verified, and it corrects an earlier draft of this
  spec): the ETH/USD feeds the live modules actually use are all far TIGHTER
  than their 6h staleness - Arbitrum `0x639Fe6ab...` heartbeat 1755s (observed
  62s old), Optimism `0x13e3Ee69...` 1200s - so there is no ETH-side
  availability risk to cite. The real margin case is the stable leg: OP
  USDC/USD has an 86400s heartbeat against the module's 93600s USDC staleness,
  i.e. only ~2h of slack, so one late heartbeat fails closed. The Unichain
  module `0xb524...8AAE` runs 26h staleness against that chain's 24h-heartbeat
  feeds - the same ~2h pattern. That thin, per-feed, per-chain margin is the
  concrete motivation for P3 route mutability: today re-sizing it means a
  redeploy.

## Interface sketch (normative shape, not final code)

```solidity
/// P2: every price source, staticcall-pure, reverts fail-closed, price in 1e18 USD.
interface IOphisPriceSource {
    /// 1e18-USD price AND the timestamp it was observed, so the MODULE enforces
    /// staleness rather than trusting each adapter to police itself.
    /// Reverts fail-closed on invalid or out-of-bounds values.
    function priceUsd18() external view returns (uint256 price, uint256 updatedAt);
    /// Registration-time self-description, checked against the route config so a
    /// USD feed cannot be silently registered where an exchange rate is meant,
    /// and so REGISTRATION-ONLY sources can never gate a fill.
    function sourceKind() external view returns (uint8 kind, bool fillEligible);
}

contract OphisVaultPolicyModuleV2 is ReentrancyGuard /*, ISafeSignatureVerifier */ {
    enum Mode { Presign, Eip1271 }            // per-vault, immutable at deploy
    // tokenDecimals stays CACHED here: floorBuyAmount still takes both token
    // decimals as arguments, and priceUsd18() only absorbs FEED decimals.
    struct TokenRoute { bool allowed; uint8 tokenDecimals; IOphisPriceSource source; }
    struct TokenAdd  { address token; IOphisPriceSource source; /* probe cfg */ }
    // validTo is STORED, never re-read from a caller-supplied uid (see cancel).
    struct OrderState { address sellToken; address buyToken; uint32 validTo;
                        uint96 registeredAt; uint256 minBuyOverride; uint256 sellUsd18; }
    // Per-sell-token live slot (extends Phase B's liveAllowanceUid pair).
    // Self-overwriting on supersede => O(allowlist) storage, ZERO history.
    // uid is the full 56 bytes: validTo is NOT recoverable from the digest,
    // and both setPreSignature/invalidateOrder need the bytes.
    struct LiveOrder { bytes uid; address buyToken; bytes32 digest; }

    mapping(bytes32 => OrderState) internal orderState;      // digest-keyed, O(1) reads only
    mapping(address => LiveOrder)  internal liveOrder;       // sellToken => its single live order
    address[] public allowedTokens;                          // capped at MAX_ALLOWED_TOKENS
    // NOTE: deliberately NO token => uid[] index. A fill (STATICCALL) and a
    // passive expiry cannot prune such an array, so it would grow per
    // rebalance and let a compromised curator gas-brick removeToken.

    // P1 - curator surface (unchanged names, extended semantics)
    function rebalance(GPv2Order.Data calldata order, uint256 minBuyOverride)
        external returns (bytes memory orderUid);        // registers (1271) or presigns (presign mode)
    function cancel(bytes32 digest) external;            // uid REBUILT internally; never trust caller uid bytes

    // P1 - EFH callback (view; the fill-time gate)
    function isValidSafeSignature(
        address safe_, address sender, bytes32 _hash, bytes32 domainSeparator_,
        bytes32 typeHash, bytes calldata encodeData, bytes calldata payload
    ) external view returns (bytes4 magic);

    // P3 - admin surface (curator has NO access to any of these)
    function submitTokenAdd(TokenAdd calldata add) external;    // only address(safe)
    function executeTokenAdd(TokenAdd calldata add) external;   // ONLY address(safe), within [eta, eta+WINDOW], revalidates
    function cancelPending(bytes32 key) external;               // guardian or safe, instant
    function removeToken(address token) external;               // guardian or safe, instant, revert-TOLERANT sweep
    function sweepResidual(address token) external;             // retry residual revocations that failed
    function rotateGuardian(address newGuardian) external;      // ONLY address(safe); guardian must not be entrenchable
}
```

Constructor additions: `Mode mode`, `address guardian`, `uint256 delay`
(>= 24h, immutable), `uint256 executeWindow` (immutable), `TokenRoute[]`
initial set (same probe discipline as Phase B, length <=
`MAX_ALLOWED_TOKENS`). Factory enforces curator-not-owner/module exactly as
today, plus `guardian != curator`.

## Security invariants (Phase C additions, C1-C16)

These are DESIGN obligations, not achieved results - nothing here is
implemented yet. Each must be discharged by unit + fuzz + fork tests in C1-C3;
the verification log tracks which currently have no assigned target.

- **C1**: no order can reach a valid 1271 answer unless its digest was
  registered by `rebalance` under the full Phase-B policy. (Registration
  gating; covers forged-payload and cross-Safe replay - EFH binds digest to
  struct, the module binds digest to its own registration for THIS safe.)
- **C2**: at any block where `isValidSafeSignature` returns magic,
  `order.buyAmount >= max(oracleFloor(block), minBuyOverride)` with all
  adapter reads fresh and the sequencer gate passing. (The fill-time floor.)
- **C3**: `isValidSafeSignature` performs zero state writes and reverts (never
  returns wrong-magic silently) on policy failure, with transient/fatal typed
  reasons. (STATICCALL-compatible; orderbook/driver behavior deterministic.)
- **C4**: turnover is charged exactly once per registration and refunded at
  most once, ONLY for an order cancelled strictly within its validity window
  (`block.timestamp <= validTo`) and with `filledAmount(uid) == 0` at that
  block; no filled order is ever refunded, including after any third party
  calls `freeFilledAmountStorage`, and including any cancel whose uid bytes
  were forged. Cumulative refunds NEVER exceed cumulative charges - the
  existing suites assert only the bucket LEVEL (`turnoverSpentUsd <= cap`),
  which no refund bug can ever falsify, so C4 requires a new ghost-variable
  property comparing totals. Refund arithmetic saturates at zero: a naive
  subtraction underflow-reverts on a drained bucket and, through the shared
  cancel path, would propagate into `removeToken`. Bucket accounting never exceeds Phase-B
  bounds (instantaneous <= cap, rolling 24h <= ~2x cap). (Fuzz target: fill an
  order, warp past `validTo`, zero its `filledAmount` as a solver would, then
  assert `cancel` refunds nothing.)
- **C5**: `cancel` and supersession leave no fillable path, by the mechanism
  appropriate to the mode: Eip1271 -> deregistered (the fill-time check then
  refuses) AND `invalidateOrder` sets `filledAmount = uint256.max`; Presign ->
  `setPreSignature(uid, false)` MUST succeed, there being no fill-time gate to
  fall back on. `filledAmount` and `preSignature` are separate raw-uid
  mappings, so neither call substitutes for the other. Allowance rules preserved
  (<= 1 live order per sell token; allowance == that order's amount - the
  existing invariant suite extends to 1271 mode).
- **C6**: in Presign + FROZEN mode the module's order path is behaviorally
  identical to Phase B except `cancel`'s turnover refund (a strictly
  depositor-favorable delta; refunds apply uniformly in both modes). The V1
  order-path test suite passes against V2-in-presign+frozen mode modulo the
  refund assertions. (Default deployments are timelocked and additionally
  carry the P3 admin surface - deltas enumerated, not hidden.)
- **C7**: the curator cannot cause any admin-state transition: not propose,
  not execute, not cancel pendings, not remove tokens (enforced by
  construction: every admin entrypoint gates on `msg.sender == address(safe)`
  or the guardian; none accepts the curator).
- **C8**: a token becomes allowed only via `executeTokenAdd` - callable by the
  Safe ONLY (never the guardian; see C10) - inside `[eta, eta + EXECUTE_WINDOW]` after a
  Safe-proposed `submitTokenAdd`, with execute-time revalidation passing; a
  pending outside its window is dead.
- **C9**: `removeToken` is instant and atomically deregisters + invalidates
  EVERY live order the token appears in (sell side or buy side) and zeroes the
  sell-side allowance(s); after it no new registration, no 1271 validation,
  and no module-created presignature can involve that token.
- **C15**: `removeToken` ALWAYS succeeds in de-allowlisting for any token or
  order state a token can induce - no ERC20 behaviour (pausing, blacklisting,
  reverting approve) can block it, because the policy-critical settlement calls
  never touch the token. Two parts: (i) gas is statically bounded and
  independent of history - at most one settlement call per allowlisted token
  (`allowedTokens.length <= MAX_ALLOWED_TOKENS`), and no code path lets order
  activity grow any structure removal must iterate; (ii) no external call can
  revert the de-allowlisting - storage is updated first and every residual
  revocation is individually failure-isolated, so a paused, blacklisting or
  otherwise hostile ERC20 cannot brick removal of itself OR of any unrelated
  token. (Fuzz targets: arbitrary register/cancel/supersede/expire sequences
  then assert `removeToken` succeeds within a fixed gas budget; and a token
  whose `approve` always reverts must still end up de-allowlisted with its
  orders policy-dead.)
- **C10**: guardian powers are exclusively risk-reducing (`cancelPending`,
  `removeToken`, `sweepResidual`); no guardian path adds a token, raises a
  cap, or loosens any parameter - in particular the guardian CANNOT execute a
  pending add, because execution is what widens the set. Only the Safe
  proposes and only the Safe executes.
- **C16**: the guardian is rotatable by the Safe, but rotation cannot be used
  to escape a veto and cannot hand the role to the curator. Both were holes in
  the first draft of this invariant: an INSTANT rotation lets the Safe swap in
  a Safe-controlled guardian one block before a pending add matures, nullifying
  the very veto the delay exists to provide; and `guardian != curator` was
  stated only for the constructor, so rotation could set `guardian = curator`
  post-deploy and hand the curator the whole admin surface (which also
  falsifies C7). Normatively: `rotateGuardian` enforces `guardian != curator`,
  and either runs through the same DELAY as a token add or is blocked while any
  pending operation is live. A lost guardian must still never permanently DoS
  the allowlist.
- **C11**: three distinct guards: (0) staleness is enforced BY THE MODULE
  against the `updatedAt` each source returns, per-route and per-token - the
  module cannot delegate freshness to an adapter it does not control and then
  claim the property; (i) every adapter read is staticcall-pure and fail-closed on the values only
  it can judge - a zero or out-of-bounds price reverts inside the adapter
  (`InvalidOraclePrice`; staleness belongs to guard 0 alone, so each property
  has exactly ONE enforcement boundary); `Erc4626RateAdapter` enforces upper cap AND lower bound;
  `AnchoredAdapter` enforces the divergence band in both directions); and
  (ii) the module-level `ZeroOracleFloor` guard on the COMPUTED floor stays
  exactly as in Phase B - it catches a floor that truncates to zero (order
  value below one base unit of the buy token) and fails closed regardless of
  `minBuyOverride`. (ii) is not a price-source property and cannot be
  delegated to adapters.
- **C12**: `rebalance` in 1271 mode reverts unless the Safe's fallback handler
  is the pinned EFH and `EFH.domainVerifiers(safe, domainSeparator) == this`.
  (No silent fall-through to owner-threshold validation.)
- **C13**: `isValidSafeSignature` ignores `sender`/`payload` for authorization
  decisions (settlement context is adversarial; payload is unauthenticated),
  and answers ONLY for its own Safe and settlement domain
  (`safe_ == address(safe)`, `domainSeparator_ == domainSeparator`).
- **C14**: migration safety - after the C5 ceremony no order signed under a
  previous module (V1 presignature) remains fillable: every live V1 order is
  cancelled and its relayer allowance zeroed before V2 is enabled. (The
  guarantee that would otherwise have a <= V1-`maxTtl` hole.)

## Threat-model deltas vs Phase B

- **Closed**: intra-TTL adverse-move capture (Phase-B residual #1). A presigned
  order could fill up to `maxTtl` after its floor was struck; now the floor is
  re-struck at the fill block. `MAX_TTL_CAP` stays 1h at launch (it still
  bounds solver-churn and registration-DoS exposure); relaxing it becomes
  *possible* later because TTL no longer bounds price risk - a P-D decision.
- **New surface, bounded**: the EFH fallback handler answers ALL 1271 requests
  for the Safe. Mitigations: EFH is audited + 3 years in production; the
  default (non-GPv2-domain) path preserves owner-threshold semantics
  byte-for-byte vs CompatibilityFallbackHandler; the GPv2 domain routes to an
  immutable, setter-less module. Residual (documented): Safe OWNERS can always
  remove the verifier/handler or 1271-sign anything via the default path -
  unchanged trust model (owners retain full custody; Phase B/C constrain the
  CURATOR). The handler swap costs the legacy `isValidSignature(bytes,bytes)`,
  `getMessageHash*`, `getModules()`, `simulate()` surfaces - documented for
  integrators; Safe{Wallet} shows a non-default-handler warning (accepted by
  every CoW TWAP Safe since 2023).
- **New surface, bounded**: P3 admin path. Worst case = compromised SAFE
  (owners) - which was always full custody; the timelock+veto exists so the
  guarantee quoted to depositors becomes "the curator cannot drain AND cannot
  change the rules; only the owners can, behind a public >= 24h delay with
  guardian veto, and removals are instant". Guardian liveness is the veto's
  weak point: mitigated by loud events (`TokenAddSubmitted/Cancelled/Executed`,
  `TokenRemoved`), Telegram alerting wired into the existing watcher, veto
  shared guardian+Safe, and the expiry window (a missed add dies on its own).
- **Accepted**: registration-DoS by compromised curator (bucket exhaustion via
  never-fillable orders) - bounded by refund-on-cancel + owners can always
  disable the module; solver-cycle churn from near-floor orders - bounded by
  builder buffer + TTL; hosted-chain solver deprioritization - not ours to
  control, monitored via fill latency.
- **Unchanged**: oracle-quality risk moves INTO the adapter catalog - which is
  the point (auditable, bounded, per-token) - with the wUSDM-class donation
  vector explicitly killed by mandatory bounds on RATE-class sources.

## safe-swap / services / infra changes

- **safe-swap**: add the eip1271 build path (today `signingScheme: 'presign'`
  is hardcoded at `build.ts:163,202`): construct the `safeSignature`-selector
  blob, post with `from = safe`, handle the two new placement failure modes
  (`InvalidEip1271Signature`, `TooMuchGas`) distinctly, and keep
  `assertUidMatches` (uid derivation is scheme-independent). The presign path
  stays; mode selected per vault.
  **The flow INVERTS and this is not a one-line scheme swap.** Today
  `buildOphisSafePresign` posts the order first (`api.sendOrder`,
  `build.ts:204`) and merely RETURNS the tx batch for the caller to execute
  afterwards (`build.ts:8,232`). In 1271 mode with creation-validation on, the
  POST itself staticcalls our verifier, which reverts `OrderNotRegistered`
  until `module.rebalance` has landed on-chain - so **registration must
  precede placement**: (1) build+quote off-chain, (2) curator sends
  `module.rebalance` (wiring assert, policy, turnover charge, allowance,
  registration), (3) only then `api.sendOrder` with the 1271 blob. safe-swap
  therefore gains a two-step API in 1271 mode (`buildOphisVaultOrder` ->
  caller executes -> `submitOphisVaultOrder`) rather than the current
  post-then-return-txs shape. A naive scheme-string swap would 400 on every
  order. This ordering is normative for milestone C1.
- **services/backend**: NO changes required. Verified against our actual pin
  (`apps/backend` = subtree of cowprotocol/services @ upstream `0720b9bc`,
  2026-04-30, recorded in `.greg-upstream`): full 1271 placement + creation
  simulation via the deployed `Signatures` contracts, post-#4118
  no-revalidation model, per-block driver resimulation. Config already
  correct: `eip1271-skip-creation-validation = false` on both chains.
- **infra**: Unichain EFH replay-deploy (one funded tx to the CREATE2 proxy;
  initcode preserved); per-chain deploy scripts extended with the wiring
  ceremony (Safe owners: `setFallbackHandler(EFH)` THEN
  `setDomainVerifier(domainSeparator, module)`). Two mechanics the scripts
  must get right: (a) a single `execTransaction` has one `to`, so batching two
  self-calls requires `operation = DELEGATECALL` into MultiSendCallOnly -
  which is what the Safe Transaction Builder emits, but is NOT what the
  existing enableModule step does (that runbook step is one plain
  transaction, so it is not a template for this); (b) **the order is
  mandatory** - `setDomainVerifier` is `onlySelf` on the EFH and reachable
  only through the Safe's fallback, so if it runs before
  `setFallbackHandler(EFH)` the inner call lands on the current
  CompatibilityFallbackHandler, which has no such method, and the whole batch
  reverts. Fail-closed, but it silently blocks the ceremony if a script emits
  the calls in the wrong order;
  watch-trial-order gains 1271-order awareness (status polling identical; add
  a floor-vs-fill assertion from the `Rebalanced` event vs the settled price).
- **monitoring**: alert on `TokenAddSubmitted` (anywhere), on repeated
  transient-revert simulation failures for a live order (floor blocking =
  expected but report it), and on `getMinDelay`-style wiring drift (fallback
  handler changed, verifier deregistered).

## Test plan

- **Unit**: every C-invariant; EFH muxer round-trip against the REAL deployed
  EFH bytecode on a fork (not a reimplementation); adapter classes incl.
  donation-attack vectors against Erc4626RateAdapter (replay the wUSDM shape),
  anchor-band both-direction breaches, RedStone/API3 round-semantics quirks.
- **Fuzz/invariant (extend the existing suites)**: Foundry StdInvariant - C4
  turnover+refund accounting, C5 one-live-order/allowance, C8/C9 pending-map
  lifecycle; Echidna/Medusa - `no_bad_1271_validation` (no unregistered digest
  ever validates), `turnover_within_cap` (extended with refunds),
  `floor_holds_at_fill` (time-warped oracle moves).
- **Fork (per chain)**: full lifecycle against REAL settlement + REAL EFH:
  deploy Safe -> enable module -> wiring batch -> rebalance -> assert
  `isValidSignature` magic via the actual Safe fallback path -> warp oracle ->
  assert revert -> cancel -> assert invalidated. On Unichain fork: EFH
  replay-deploy first, then the same suite. Preflights keep the
  `vm.skip(true)`-without-RPC discipline and `require(block.chainid == N)`.
- **E2E (gated, OP first)**: place a real 1271 order on the sovereign
  orderbook, verify creation-time simulation passes, verify a real solver
  fills it, verify watcher output; then a deliberate below-floor order:
  verify 400 at placement; then a floor-flip mid-TTL: verify no fill + clean
  expiry. This is the C5-trial analogue of the Phase-B B5 trial.

## Milestones

- **C0** - this spec, reviewed. Decisions below resolved by Clement.
- **C1** - P1: ModuleV2 (dual-mode) + EFH wiring + Unichain EFH replay-deploy
  + safe-swap eip1271 path + fork suites green on all 5 chains.
- **C2** - P2: adapter catalog (PushFeed, ComposedRate, Erc4626Rate w/ CAPO
  bounds, Anchored) + module reads via `IOphisPriceSource` + per-chain route
  configs for the current token set.
- **C3** - P3: pending map + guardian + removal path + factory frozen-mode
  flag + `vault-managers.md` rewrite (same PR: lines 54/78 messaging changes
  to the "cannot drain AND cannot change the rules" framing).
- **C4** - audit gates (all of: 12-agent solidity-auditor, ToB semgrep,
  Echidna/Medusa extended props, Codex review rounds, x-ray refresh) +
  post-audit hardening.
- **C5** - gated live rollout, OP trial first (sovereign, we control driver
  behavior), then Base/Arb/Ethereum, then Unichain (after EFH replay-deploy);
  same runbook discipline as Phase B. **Migration ceremony (ordered, and the
  order matters):** (1) curator `cancel`s every live V1 order and confirms
  zero residual relayer allowance - `disableModule` alone does NOT revoke a
  V1 presignature or its allowance (both live in settlement/token storage the
  Safe owns), so a V1 order presigned just before migration stays fillable at
  its V1-signed limit for up to V1's `maxTtl` with no fill-time floor; (2)
  disable V1; (3) enable V2 + the EFH/verifier wiring batch. If step (1) is
  skipped, the P1 guarantee has a <= 1h hole - this is the Phase-B NatSpec's
  "disable the old module and let its orders expire/cancel first" rule, now
  load-bearing. V2 enablement additionally zeroes any residual relayer
  allowance it finds for allowlisted tokens as belt-and-suspenders.

## Open decisions (for review - recommendation first)

1. **Default mode**: recommend Eip1271 default on sovereign chains (we control
   the full stack), per-vault choice on hosted chains (third-party solver
   deprioritization risk is theirs). Presign mode remains for
   fallback-handler-averse Safes.
2. **Turnover refund-on-cancel**: recommend YES, unfilled-only (as specced).
   Alternative: no refunds (simpler, harsher DoS surface).
3. **Allowlist default**: recommend timelocked default + frozen factory flag.
   Alternative: frozen default (stronger static story, keeps redeploy tax).
4. **Anchor mandatory-ness**: recommend mandatory for RATE-class (ERC-4626)
   sources and for ExR-composed BUY-side tokens on Unichain; optional
   elsewhere. Alternative: mandatory everywhere (more feeds to maintain, more
   fail-closed downtime).
5. **Guardian identity**: recommend a dedicated Ophis ops Safe per chain as
   the DEFAULT guardian offered to trial/partner vaults, with vaults free to
   name their own; guardian is per-vault config either way.
6. **MAX_TTL in 1271 mode**: recommend keep 1h at launch, revisit after C5
   fill-latency data (fill-time floor removes the price-risk argument for
   short TTLs; solver-churn and registration-DoS remain).
7. **Scope check**: P2 catalog initially ships PushFeed + ComposedRate +
   Erc4626Rate + Anchored only. Chronicle (kiss dependency) and Pyth
   (keeper dependency) stay out until a partner needs them.

## Verification log

Research-stage corrections (found by the adversarial verification pass, already
applied above):

- ComposableCoW/EFH deployment reality: `networks.json` is stale (omits
  OP/Base where code IS live, and Unichain where it is not); on-chain
  `eth_getCode` is authoritative. The OP ComposableCoW is bound to the
  canonical settlement domain - reuse ruled out; EFH is settlement-agnostic.
- Driver bad-order detector: OFF by default entirely
  (`enable-metrics-bad-order-detection = false` gates the whole strategy; the
  0.9/20/10min/log-only knobs only matter once enabled). Spec text reflects
  "off by default + our TOMLs set nothing".
- Orderbook 1271 gas measurement: measured inside the `Signatures` helper via
  `simulateDelegatecall` (no `eth_estimateGas`, no 21k subtraction - that text
  is a stale services doc comment).
- EFH fallback semantics precision: malformed-but-selector-matching blobs with
  a registered verifier revert in `abi.decode` rather than falling through;
  security outcome identical (order rejected).
- Veda Accountant pause pattern (considered for adapters): its
  `updateExchangeRate` STORES the out-of-bounds rate and only the `*Safe`
  getters revert - if any adapter borrows the pattern, gate reads on the pause
  flag explicitly. (We don't borrow it; CAPO+bounds is the chosen shape.)
- Aera `disableOracle` is not unconditionally fail-closed while an update is
  pending (early-accept override is checked first) - our P3 has no
  early-accept mechanism, avoiding the stale-override re-activation quirk
  entirely.
- Morpho docs "cap decreases happen instantly" is a paraphrase, not a quote -
  not used verbatim anywhere public.
- Milkman's address(0)-price-checker footgun was fixed pre-deployment
  (deployed bytecode verified to enforce the check); its README remains stale
  - cited only as a documentation-drift cautionary tale.

Draft-stage verification: this spec itself was adversarially re-verified after
writing, by four independent lenses (protocol mechanics vs vendored GPv2 +
services pin + on-chain probes; oracle ground truth vs live chains;
adversarial design soundness; internal/repo consistency). Findings, all
applied above:

- (MAJOR, consistency) C7 originally claimed the curator "cannot execute"
  while the interface sketch made `executeTokenAdd` permissionless - a
  self-contradiction. Resolved by GATING execute to Safe-or-guardian
  (deliberate deviation from Morpho/OZ/Aera anyone-executes, matching our live
  AllowListGuardian posture) and rewording C7/C8.
- (MAJOR, consistency) C6 "presign mode identical to Phase B" was falsified by
  the spec's own defaults (timelocked allowlist, refund-on-cancel). Rescoped
  to Presign+frozen with the refund delta enumerated; refunds stated to apply
  uniformly in both modes.
- (MAJOR, consistency) Removal only settled SELL-side live orders; a live
  order BUYING the removed token survived in presign mode (bookkeeping is
  sell-token-keyed in Phase B). Fixed: `buyToken` tracked per live order,
  `removeToken` revokes both sides, C9 restated.
- (MINOR, consistency) OrderState field list unified (registeredAt, buyToken;
  validTo re-derived from encodeData); bad-order detector "five knobs" ->
  "its knobs" (`BadOrderDetectionConfig` has nine fields); AllowListGuardian
  provenance corrected
  (chain-governance pattern, not a Phase-B artifact); the 6h-staleness
  liveness example now names the right modules/chains (OP/Base/Arb/Eth module
  6h vs Unichain module 26h - verified on-chain).
- (MAJOR, design) The safe-swap change-list understated the work: 1271
  requires register-on-chain BEFORE placement, inverting today's
  post-then-return-txs flow (`build.ts:8,204,232`). A scheme-string swap alone
  would 400 every order. safe-swap section rewritten with the normative
  two-step API; C1 scope updated.
- (MAJOR, design) The C5 migration ceremony was unsafe as written:
  `disableModule` does not revoke V1's presignatures or relayer allowance, so
  a V1 order signed just before migration stays fillable at its V1 limit -
  with no fill-time floor - for up to V1's `maxTtl`. Ceremony reordered
  (cancel V1 orders -> disable V1 -> enable V2 + wiring), residual documented,
  new invariant C14 added.
- (MINOR, design) `removeToken`'s buy-side sweep needed enumerable state that
  the data model did not provide (digest-keyed mappings cannot be walked).
  First fix added `allowedTokens[]` + a `token => uid[]` index - **superseded
  by PR-review round 1 below**, which showed that index is unbounded; the
  shipped design uses bounded per-sell-token slots instead.
- (MINOR, design) Added an explicit `safe_ == address(safe)` pin in
  `isValidSafeSignature` (EFH's `domainVerifiers` is caller-scoped, so a
  foreign Safe could name this module as verifier - harmless via
  receiver-pinning, but now excluded outright) and folded it into C13.

Audit-gate round (2026-07-20): 9-lens solidity-auditor fleet (63 raw findings,
each adversarially verified refute-by-default -> 39 confirmed), plus ToB
semgrep, Echidna 60k, Medusa 132k, forge 311/311, and an x-ray pass. Gate
results: semgrep 0 findings; all fuzz properties passing; x-ray verdict
HARDENED with no exploitable finding in the LIVE contracts. The design,
however, took real damage - the fleet found a CRITICAL and several HIGHs, and
two of them were introduced by MY OWN earlier fixes in this same document:

- (CRITICAL, fixed) **`cancel` read policy inputs out of a caller-supplied
  uid.** Moving order state to digest keying meant `cancel(bytes orderUid)`
  authenticated only 32 of 56 bytes, while BOTH refund gates consumed the
  unauthenticated tail: `validTo` (my round-2 "fix") and the `filledAmount`
  lookup, which keys on RAW uid bytes. Forging the 4 `validTo` bytes satisfies
  the time gate AND re-keys `filledAmount` to a virgin slot reading zero -
  refunding an order that filled, repeatably, unbinding `dailyUsdTurnoverCap`
  completely. Presign mode is worse: the forged uid revokes nothing while the
  real order stays PRE_SIGNED and fillable. Phase B was immune only because it
  keys on `keccak256(uid)` over all 56 bytes. Fixed: `cancel(bytes32 digest)`,
  `validTo` stored in `OrderState`, uid rebuilt internally via
  `packOrderUidParams`. LESSON: my round-2 fix closed a hole by adding a check
  that read attacker-controlled input - a check on untrusted data is not a
  check.
- (HIGH, fixed) **The fill-time floor is evaluated AFTER solver-controlled
  pre-interactions**, inside the settlement transaction. Any source whose value
  is a function of live state a settling solver can write in the same tx -
  `convertToAssets` above all - can be bent downward immediately before
  `isValidSignature` reads it, defeating P1's entire premise. Fixed by
  classifying sources FILL-ELIGIBLE (externally-pushed oracles) vs
  REGISTRATION-ONLY (live protocol reads), and forbidding the latter from
  gating fills; Eip1271-mode routes must be wholly FILL-ELIGIBLE. This costs
  real coverage and the spec now says so instead of overclaiming.
- (HIGH, fixed) **`removeToken`'s all-or-nothing sweep could be bricked by one
  hostile ERC20.** A pausable/blacklisting token whose `approve` reverts would
  block removal of itself AND of every unrelated token - the exact emergency
  the function exists for. Fixed: de-allowlist storage first and
  unconditionally, then failure-isolate each residual revocation, with a
  retryable `sweepResidual`. C15 now bounds reverts, not just gas.
- (HIGH, fixed) **Guardian-as-executor was additive power**, falsifying C10 and
  inverting the AllowListGuardian precedent. This was my round-1 fix
  over-correcting: I gated `executeTokenAdd` to Safe-or-guardian "for timing",
  but execution is precisely what widens the token set. Now Safe-only.
- (HIGH, fixed) **A liveness probe is not identity validation**: a nonzero
  return cannot distinguish a USD price from an exchange rate, a
  decimals-mismatched proxy, a live TEST-CAPPED feed, or a constant.
  Registration now also checks self-declared `sourceKind`/`fillEligible` and a
  proposer-supplied sanity band.
- (MEDIUM, fixed) **`priceUsd18()` carried no freshness**, so C11's
  per-adapter fail-closed staleness claim was unverifiable on-chain. The
  interface now returns `(price, updatedAt)` and the MODULE enforces staleness.
- (MEDIUM, fixed) Guardian was immutable with no rotation path (permanent DoS
  on loss/compromise) and `guardian != curator` was factory-only, so a direct
  deploy could hand the curator the whole admin surface. Added
  `rotateGuardian` (Safe-only) and constructor enforcement; new invariant C16.
- (MEDIUM, fixed) **The turnover invariants could never catch a refund bug**:
  both existing properties assert only the bucket LEVEL, which no refund error
  falsifies. C4 now requires a ghost-variable property that cumulative refunds
  never exceed cumulative charges, and specifies saturating refund arithmetic
  (a naive subtraction underflow-reverts on a drained bucket and propagates
  through the shared cancel path into `removeToken`).

RE-VERIFICATION ROUND (2026-07-20, 4 lenses on the rewritten spec). This round
found TWO BLOCKERS, both in fixes introduced by the two rounds immediately
before it, plus ~20 MAJORs concentrated in the same two lanes. Applied:

- (BLOCKER, fixed) **FILL-ELIGIBLE was defined by vendor brand, and two of its
  three families do not have the property.** The class was written as "push
  oracles (Chainlink, RedStone push, API3)". Only Chainlink qualifies: OCR
  `transmit` is transmitter-allowlisted AND EOA-only, so it is unreachable from
  the settlement contract. RedStone push and API3 both use sign-off-chain /
  anyone-relays - `updateDataFeedsValuesPartial` is `public` with an empty
  `requireAuthorisedUpdater` ("By default, anyone can update data feed
  values"), accepts ~3-minute-old payloads with no deviation bound and skips
  failures silently; `updateBeaconWithSignedData` is guarded only by an Airnode
  signature check, and permissionless in-tx updating is API3's design intent.
  So a settling solver could pick the most favourable signed price in the
  window and push it as a pre-interaction, setting `oracleFloor(block)` itself
  and falsifying C2. Worse, the Unichain wstETH route's MANDATORY anchor was
  the RedStone wstETH/ETH feed, so a solver could suppress a genuine depeg
  signal in-transaction. Independently reproduced before accepting.
  Fixed by defining the class by WRITE-PATH MECHANISM (privileged-writer
  allowlist) rather than brand. Coverage consequence, stated plainly: Unichain
  USDT/USD has no fill-eligible source at all, and the wstETH anchor must be
  re-sourced or that route runs Presign.
- (BLOCKER, fixed) **Codehash pinning cannot decide fill-eligibility.** Two
  reasons, either fatal: Solidity inlines `immutable`s into runtime bytecode,
  so PushFeedAdapter instances differing only in configuration have different
  codehashes and no fixed pin admits the family; and eligibility is a property
  of the CONFIGURED FEED ADDRESS, not of the adapter's code - identical audited
  bytecode is eligible or not depending on its `proxy` field. Replaced with an
  explicit per-chain allowlist of verified FEED ADDRESSES, extended only
  through the P3 timelock (where "this feed's write path is
  privileged-writer-gated" is exactly the claim a public delay lets reviewers
  check).
- (MAJOR, fixed) **A claim I made in the Codex round was simply false**: that a
  freezable ERC20 could brick `setPreSignature` and that Presign allowlists
  must therefore exclude such tokens. `setPreSignature`/`invalidateOrder` are
  settlement calls with ZERO token interaction. The listing rule is withdrawn,
  and this also dissolves the C15 contradiction - since no token can force the
  policy-critical call to fail, de-allowlisting is genuinely unconditional.
- (MAJOR, fixed) **`rotateGuardian` nullified the veto it shipped beside**: an
  instant Safe-only rotation lets the Safe install a friendly guardian one
  block before a pending add matures. It also carried no `guardian != curator`
  check, so rotation could hand the curator the admin surface and falsify C7.
  C16 now requires the check and either a DELAY on rotation or a block while
  pendings are live.

STILL OPEN from this round - these are NOT patched, and they are the reason the
next step is a consolidation rewrite of the P1/P2 sections rather than a sixth
patch (see "Status" below): `AnchoredAdapter` is absent from the eligible-source
story, so the mandatory anchor and the eligibility rule are jointly
unsatisfiable as written; `priceUsd18()` returns a single scalar `updatedAt`
while `ComposedRateAdapter` has per-leg staleness, and the spec never says what
a multi-leg source reports; `TokenRoute`/`TokenAdd` carry no staleness field at
all although C11 requires per-token staleness; CAPO CLAMPS rather than reverts
and its snapshot needs a governance re-set that the immutable-adapter model
forecloses; four of the ten Unichain "production" feeds are Chainlink SVR
(OEV-auction) feeds - including the ETH/USD feed the live module uses - which
the catalog never mentions; Ethereum has no ExR PROXY for several assets the
spec assumes (those RDD rows are Data Streams, `proxyAddress: null`, not
adapter-readable); neither added registration check actually separates the TEST
CAPPED feed from a production one (it returns $0.99988 at 8 decimals); the
de-allowlist-first ordering and the sweep that iterates `allowedTokens` are
order-incompatible; `sweepResidual` has no residual state to operate on and is
keyed by the wrong token for buy-side removals; C6's Presign-parity claim is
unachievable now that `cancel`'s signature changed; "same probe discipline as
Phase B" contradicts the identity-validation paragraph; and the test plan and
the TRACKED list contradict each other on which invariants have targets.

Codex gate (final, 2026-07-20). Verdict: the CRITICAL cancellation fix is
"complete if implemented literally" - no caller-controlled uid tail reaches the
refund gate, `filledAmount`, `invalidateOrder` or `setPreSignature` - and
genuine authenticated push feeds do close the solver pre-interaction vector.
Codex withheld approval for implementation on two grounds, both now addressed:

- (HIGH, fixed) **My two fixes conflicted.** Making the removal sweep
  revert-tolerant is safe in Eip1271 mode, where de-allowlisting itself is the
  enforcement, but in Presign mode `setPreSignature(uid, false)` IS the
  enforcement and the settlement's `preSignature` mapping is independent of our
  storage - so swallowing that failure leaves the order still fillable at its
  old floor with a live allowance, making C9's "invalidates EVERY live order"
  stronger than the mechanism. Residual steps are now classified: policy-
  critical revocation must succeed (or `removeToken` reverts) in Presign mode;
  allowance hygiene, and revocation in Eip1271 mode, stay failure-isolated.
  Consequence stated rather than hidden: Presign-mode allowlists must exclude
  tokens whose approve/transfer a third party can freeze, and that is a concrete
  reason to prefer Eip1271 mode.
- (HIGH, fixed) **FILL-ELIGIBLE was self-declared.** An adapter asserting its
  own `fillEligible` is a claim by the contract whose trustworthiness is in
  question. Eligibility is now rooted in PINNED implementations - `extcodehash`
  checked against audited adapter codehashes recorded at module construction,
  with composition leaves checked recursively so a ComposedRateAdapter cannot
  smuggle a REGISTRATION-ONLY leg underneath; `sourceKind()` is demoted to a
  redundant cross-check.
- (LOW, fixed) Stale text the earlier edits left behind, all security-relevant:
  the lifecycle still said `module.cancel(orderUid)` and "extract validTo from
  the uid"; registration omitted stored `validTo`; C8 still granted the
  guardian execution power that C10 and the interface had removed; C5
  unconditionally required `filledAmount = max` although Presign revokes via
  `setPreSignature`; C11 assigned staleness to both module and adapter; and the
  invariant heading claimed C1-C13 were "all unit+fuzz+fork tested" in a
  document whose first line says nothing is implemented.

TRACKED, not yet folded into the design text (for C1 scoping - each is
confirmed and none changes the lanes above): the anchor band's fail-closed
semantics can trap a vault in a genuinely depegging asset, whereas the cited
precedents deliberately switch source instead - needs an explicit
depeg-exit policy; turnover is charged on the ABSOLUTE price while the floor
depends only on the RATIO, so P2's oracle error budget does not bound the
bucket, and oracle staleness error is un-damped (it lowers the floor and
under-charges the bucket simultaneously); P2's oracle-band term is missing from
the worst-case bleed formula the cap is sized against, and no Ophis bounds are
stated for `maxDivergenceBps` or the CAPO growth parameter; `EXECUTE_WINDOW`,
`DELAY` and `MAX_ALLOWED_TOKENS` are unbounded/unspecified and whether
`removeToken` compacts `allowedTokens` decides if the cap is concurrent or
lifetime (C15's "independent of history" holds only under one reading);
`EFH.domainVerifiers` is one slot per `(safe, domainSeparator)`, so the wiring
ceremony silently clobbers any pre-existing CoW verifier and a later
re-registration silently un-wires the vault module; pending lifecycle lacks a
token-to-key index and stated re-submit/expiry/delete behaviour; `rebalance`
should reject uids with nonzero `filledAmount` (re-registration after
`invalidateOrder` is a silent no-op that still charges turnover and arms an
allowance); the anti-flapping floor buffer is enforced only off-chain by the
party assumed compromised, so section 5's "no on-chain revert" overclaims; C14
is a runbook procedure presented as an invariant and its on-chain
belt-and-suspenders is defeated by V2's own first rebalance; "`filledAmount`
marks the uid replay-safe forever" is false as written (the real protection is
`validTo`); the invariant handler has no fill action, so C5 is falsified by any
fill, and C7/C10/C12/C13 have no assigned test target.

LIVE-CONTRACT observations (all LOW/INFO, none exploitable, for a separate
hardening PR - the deployed modules are immutable so these are Phase-D or
redeploy items): expired orders leave a permanent exact-size relayer allowance
and a live presignature, and the invariant suite structurally cannot detect it;
`read18` trusts deploy-time-cached `feedDecimals`, so a decimals change behind
a Chainlink proxy silently rescales the floor by 10^delta without tripping
`ZeroOracleFloor`; `read18` accepts a future-dated `updatedAt`, making the
staleness check unconditionally pass; every re-price burns the full notional
from the bucket with no refund, so effective throughput sits far below the
nominal cap; `MAX_TOKEN_DECIMALS = 36` puts the `floorBuyAmount` numerator
overflow within reach at ordinary sizes for a high-decimal buy token; and
`Factory.deploy` is permissionless and does not bind the module address to its
config. Separately, x-ray found the fuzz harness itself was misconfigured -
`medusa.json` targeted another worktree - which is fixed in this branch.

PR-review round 1 (both P1, both valid, both applied - they invalidated the
first attempt at the buy-side removal fix):

- (P1) The proposed `token => uid[]` live-order index was **unprunable and
  therefore unbounded**: a fill is observed only inside `isValidSignature`
  (STATICCALL - cannot write) and a passive expiry has no transaction at all,
  so entries for filled/expired orders would accumulate one per historical
  rebalance and `removeToken` would eventually revert on gas - letting a
  compromised curator gas-brick the guardian's instant-removal power by
  spamming registrations. Redesigned onto **bounded per-sell-token slots**
  (extending Phase B's already-invariant-tested `<= 1 live order per sell
  token`) plus a length-capped `allowedTokens`; removal is now at most one
  settlement call per allowlisted token, with zero historical retention. New
  invariant C15 makes the bound explicit and fuzz-tested.
- (P1) The index stored **digests, from which a uid cannot be reconstructed**
  (uid = `digest || owner || validTo`; `validTo` is hashed into the digest but
  not recoverable from it), so neither `setPreSignature` nor `invalidateOrder`
  could be called for buy-side orders in presign mode. The live record now
  stores the full uid bytes - which is exactly why Phase B carries
  `liveAllowanceOrderUid` beside `liveAllowanceUid`; the first draft
  re-introduced a bug Phase B had already solved.

Verified-positive findings worth recording (they retire open questions rather
than change the design): EFH's muxer interface, the `0x5fd7e97d` selector, and
the digest re-derivation all match the spec exactly, and collision resistance
means the module provably receives the settled order - payload forgery is not
possible; when the verifier or handler is removed AFTER registration, EFH
falls through to `defaultIsValidSignature`, which reverts on our blob - i.e.
un-wiring fails CLOSED at fill, so C12's wiring check at `rebalance` time is
sufficient and is not a policy-bypass window; and the settlement independently
enforces `executed >= signed buyAmount` for fill-or-kill sell orders, which is
what makes the C2 phrasing accurate.

Draft-stage round 2 - the protocol-mechanics and oracle-ground-truth lenses
(initially lost to API overload) completed on retry. All four lenses have now
reported; findings applied:

- (MAJOR, mechanics) **The turnover refund was exploitable and would have
  partly unbound the daily cap.** `filledAmount(uid) == 0` is not a sound
  "never filled" test after expiry: `freeFilledAmountStorage` zeroes that slot
  for any expired uid and is guarded only by `onlyInteraction`, so any solver
  can trigger it from a settlement's interaction list. Fill -> expire ->
  solver frees the slot -> `cancel` refunds an order that actually settled,
  repeatable every TTL window. Fixed by gating the refund on
  `block.timestamp <= validTo` (which the audit round then showed must be READ
  FROM STORAGE, not from the uid - see the CRITICAL below), which
  also enforces the spec's stated "no refund on passive expiry" intent that
  nothing previously enforced. C4 restated and given a fuzz target.
- (MAJOR, oracles) The Unichain catalog was wrong: 12 RDD entries are not all
  18-decimal/24h - one is the 0-decimal sequencer feed and one is a LIVE
  8-decimal `USDC / USD TEST CAPPED` proxy, making three live USDC/USD-named
  proxies. Corrected, and it strengthens the pin-by-address rule.
- (MAJOR, oracles) The staleness liveness example was factually wrong: the
  ETH/USD feeds the live modules use have 1755s (Arb) and 1200s (OP)
  heartbeats, not 24h, so the ETH-side availability risk I described does not
  exist. Replaced with the real thin-margin case (OP USDC/USD 86400s heartbeat
  vs 93600s configured staleness, ~2h slack).
- (MAJOR, oracles) Liquity attribution corrected: its 1% is stETH/USD-vs-
  ETH/USD and 2% is rETH market-vs-canonical - both LST checks, both selection
  switches rather than fail-closed bands. Liquity has no stables/majors
  threshold to borrow; our stables band is a Phase-C parameter choice.
- (MINOR, mechanics) EFH does not `require` on digest mismatch - it falls
  through to `defaultIsValidSignature`, which reverts for our blob. Same
  outcome, different mechanism; C1 tests must assert behaviour, not a
  `require`.
- (MINOR, mechanics) The wiring ceremony needs `DELEGATECALL` into
  MultiSendCallOnly to batch two Safe self-calls, and `setFallbackHandler`
  MUST precede `setDomainVerifier` (the latter is `onlySelf` on EFH and
  unreachable through the old handler). The enableModule runbook step is a
  single plain transaction and is not a template for it.
- (MINOR, mechanics) `BadOrderDetectionConfig` has nine fields, not seven.
- (MINOR, oracles) `TokenRoute` must keep a cached `tokenDecimals`:
  `priceUsd18()` absorbs FEED decimals only, while `floorBuyAmount` still
  takes both token decimals.
- (MINOR, oracles) `ZeroOracleFloor` is a module-level guard on the computed
  floor, not a price-source property - C11 split into the two distinct
  guarantees.
- (MINOR, oracles) Chainlink `deprecating` != dead: Arbitrum's ETHx/ETH ExR
  was announced for 2025-12-22 and is still publishing today. Route
  replacement must trigger on the RDD flag, not on observed liveness.


## Status after five review rounds (read this before scheduling C1)

The three lanes are sound and worth building: an EIP-1271 fill-time floor
through EFH, a bounded oracle-adapter taxonomy, and a Safe-proposed timelocked
allowlist. The verification history is in the log above and it is unusually
productive - eleven defects that would otherwise have reached contract code,
including a CRITICAL that fully unbound the daily turnover cap and two BLOCKERS
in the oracle-eligibility model.

It is also the reason this document should not go straight to implementation.
**Five of those eleven defects were introduced by earlier fixes in this same
document**, and the most recent round found two lanes whose successive patches
now contradict each other (the anchor requirement versus the eligibility rule;
the staleness model versus the adapter interface; the removal ordering versus
the sweep bound). That is patch debt, not a research gap: each fix was locally
correct and the composition drifted.

RECOMMENDED NEXT STEP - a C0.5 consolidation pass before any Solidity:
rewrite the P1 (fill-time) and P2 (oracle) sections from their current
conclusions rather than editing them again, so the eligibility rule, the anchor
requirement, the staleness model and the adapter interface are designed
together once; then re-derive C1-C16 from that text rather than carrying them
forward. The P3 lane is in better shape and mostly needs the open items above
folded in. Budget a single fresh review round on the rewritten sections, not
another patch cycle.

The seven open decisions remain the gate on all of it. Two now carry extra
weight from the final round: the FILL-ELIGIBLE correction shrinks real coverage
(Unichain USDT/USD has no eligible source; the wstETH anchor must be
re-sourced), which bears directly on decision 4 (anchor mandatoriness) and
decision 7 (initial adapter scope).
