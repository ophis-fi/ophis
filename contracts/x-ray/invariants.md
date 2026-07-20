# Invariant Map

> Ophis Vault Policy Module | 48 guards | 32 inferred | 5 not enforced on-chain

Scope: `src/contracts/vault/*` + `src/contracts/AllowListGuardian.sol`. Vendored CoW GPv2 contracts are trusted third-party and are not enumerated here except where the module's assumptions about them are load-bearing.

---

## 1. Enforced Guards (Reference)

Per-call preconditions. Heading IDs below (`G-N`) are anchor targets from x-ray.md attack surfaces.

#### G-1
`if (address(cfg.safe) == address(0) || address(cfg.settlement) == address(0) || cfg.curator == address(0)) revert ZeroAddress();` · `OphisVaultPolicyModule.sol:232-236` · All three are immutable; a zero here would permanently orphan or brick the instance with no recovery path.

#### G-2
`if (cfg.appDataHash == bytes32(0)) revert ZeroAppData();` · `OphisVaultPolicyModule.sol:239` · A zero hash would make fee-less orders policy-valid, silently disabling the Ophis partner-fee invariant.

#### G-3
`cfg.curator == address(cfg.safe)` → `BadConfig` · `OphisVaultPolicyModule.sol:241` · A Safe-as-curator would collapse the caller check into the very authority the module is meant to constrain.

#### G-4
`cfg.maxSlippageBps > MAX_SLIPPAGE_BPS_CAP` → `BadConfig` · `OphisVaultPolicyModule.sol:242` · Bounds the widest floor band any instance can ever carry (50%), so a mis-set config cannot approach a free-price order.

#### G-5
`cfg.maxTtl == 0 || cfg.maxTtl > MAX_TTL_CAP` → `BadConfig` · `OphisVaultPolicyModule.sol:243-244` · TTL is the only bound on the presign-vs-fill window; the 1h cap bounds intra-TTL adverse-move capture (Phase-B residual #1).

#### G-6
`cfg.dailyUsdTurnoverCap == 0` → `BadConfig` · `OphisVaultPolicyModule.sol:245` · A zero cap would make every rebalance revert on the turnover check — a permanent self-brick.

#### G-7
`cfg.tokens.length < 2` → `BadConfig` · `OphisVaultPolicyModule.sol:246` · A single-token allowlist admits no legal pair, since `SameToken` rejects sell == buy.

#### G-8
`cfg.sequencerGracePeriod == 0 || cfg.sequencerGracePeriod > MAX_SEQ_GRACE_CAP` (when feed set), else `cfg.sequencerGracePeriod != 0` → `BadConfig` · `OphisVaultPolicyModule.sol:249-256` · Forbids a half-configured sequencer gate in either direction (feed without grace, grace without feed).

#### G-9
`_requireCuratorNotPrivileged(cfg.safe, cfg.curator)` · `OphisVaultPolicyModule.sol:263` · The module's entire guarantee rests on the curator having no privileged path to the Safe other than this module.

#### G-10
`if (relayer == address(0)) revert ZeroAddress();` · `OphisVaultPolicyModule.sol:281` · Rejects a settlement that reports a null vault relayer, which would make every approve a no-op spender.

#### G-11
`if (token == address(0) || address(feed) == address(0)) revert ZeroAddress();` · `OphisVaultPolicyModule.sol:287-289` · Keeps the allowlist free of null entries that would otherwise read as an unconfigured-but-allowed token.

#### G-12
`if (staleness == 0 || staleness > MAX_STALENESS_CAP) revert BadConfig();` · `OphisVaultPolicyModule.sol:290-292` · Bounds the widest price age any token may ever tolerate at 2 days.

#### G-13
`if (tokenPolicy[token].allowed) revert BadConfig();` · `OphisVaultPolicyModule.sol:293` · Duplicate-token reject; a second entry would silently overwrite the first token's feed and staleness.

#### G-14
`if (tokenDecimals > MAX_TOKEN_DECIMALS) revert UnsupportedTokenDecimals(token);` · `OphisVaultPolicyModule.sol:295-297` · Bounds `10 ** tokenDecimals` so a pathological high-decimal token cannot overflow the floor math and brick every rebalance.

#### G-15
`OphisChainlinkFloor.read18(feed, feedDecimals, staleness)` · `OphisVaultPolicyModule.sol:301` · Fail-closed deploy-time liveness probe: a feed that cannot serve a valid, fresh price now does not belong in the policy.

#### G-16
`if (msg.sender != curator) revert NotCurator();` · `OphisVaultPolicyModule.sol:328` · The sole authorization on the only value-affecting entrypoint.

#### G-17
`if (msg.sender != curator) revert NotCurator();` · `OphisVaultPolicyModule.sol:390` · Restricts cancel to the curator; the operation is risk-reducing, but leaving it open would let anyone grief a live rebalance.

#### G-18
`if (sellToken == address(0)) revert UnknownOrderUid();` · `OphisVaultPolicyModule.sol:393` · Confines cancel to uids this module itself recorded, so the curator cannot revoke presignatures created by any other venue on the same Safe.

#### G-19
`if (liveAllowanceUid[sellToken] == key)` · `OphisVaultPolicyModule.sol:414` · Zeroes the shared per-token relayer allowance only when the cancelled order still owns it, so cancelling a superseded order cannot starve a live successor.

#### G-20
`if (IERC20(sellToken).allowance(address(safe), relayer) != 0)` · `OphisVaultPolicyModule.sol:417` · Avoids a needless zero→zero approve on USDT-style tokens that revert on redundant writes.

#### G-21
`if (!sellPolicy.allowed) revert TokenNotAllowed(sellToken);` · `OphisVaultPolicyModule.sol:436` · Confines the sell side to tokens whose oracle route was validated at deploy.

#### G-22
`if (!buyPolicy.allowed) revert TokenNotAllowed(buyToken);` · `OphisVaultPolicyModule.sol:437` · Confines the buy side likewise; without it a curator could route proceeds into a worthless token that still clears a one-sided floor.

#### G-23
`if (sellToken == buyToken) revert SameToken();` · `OphisVaultPolicyModule.sol:438` · A self-swap would clear the floor trivially while burning fees and turnover budget.

#### G-24
`if (order.receiver != address(safe)) revert ReceiverNotSafe();` · `OphisVaultPolicyModule.sol:442` · The receiver pin is the single control that makes proceeds unreachable by the curator; the settlement's `address(0)` "same as owner" default is deliberately not relied upon.

#### G-25
`if (order.feeAmount != 0) revert NonZeroSignedFee();` · `OphisVaultPolicyModule.sol:445` · The Ophis fee rides only in appData; a signed fee is an unpriced deduction the floor never sees.

#### G-26
`if (order.appData != appDataHash) revert WrongAppData();` · `OphisVaultPolicyModule.sol:446` · Pins the partner-fee attribution so a curator cannot redirect the fee or drop it.

#### G-27
`if (order.kind != GPv2Order.KIND_SELL || order.partiallyFillable || order.sellTokenBalance != GPv2Order.BALANCE_ERC20 || order.buyTokenBalance != GPv2Order.BALANCE_ERC20) revert BadOrderFlags();` · `OphisVaultPolicyModule.sol:447-452` · Fill-or-kill sell semantics are what make one floor evaluation bind one fill; partial fills or Balancer-vault balances would break both the floor and the allowance accounting.

#### G-28
`if (order.validTo <= block.timestamp || order.validTo > block.timestamp + maxTtl) revert BadValidTo();` · `OphisVaultPolicyModule.sol:453-456` · Bounds the window in which a struck floor can go stale against a still-fillable order.

#### G-29
`if (order.sellAmount == 0) revert ZeroSellAmount();` · `OphisVaultPolicyModule.sol:457` · A zero sell would charge no turnover while still consuming an allowance slot and a presignature.

#### G-30
`if (oracleFloor == 0) revert ZeroOracleFloor();` · `OphisVaultPolicyModule.sol:484` · Fails closed on a floor that truncates to zero regardless of `minBuyOverride`, so a curator cannot pass `minBuyOverride = 1` to admit a near-zero-proceeds order.

#### G-31
`if (order.buyAmount < requiredFloor) revert BelowFloor(order.buyAmount, requiredFloor);` · `OphisVaultPolicyModule.sol:488-490` · The core price control; `requiredFloor` is `max(oracleFloor, minBuyOverride)` so the curator can only tighten.

#### G-32
`if (answer != 0) revert SequencerDown();` · `OphisVaultPolicyModule.sol:506` · No price is trusted while an L2 sequencer is reporting down.

#### G-33
`if (startedAt == 0) revert SequencerStarting();` · `OphisVaultPolicyModule.sol:507` · Rejects an uninitialized sequencer round, which would otherwise pass the elapsed-time arithmetic below.

#### G-34
`if (block.timestamp - startedAt < sequencerGracePeriod) revert SequencerStarting();` · `OphisVaultPolicyModule.sol:508-510` · After an outage a pre-outage price can pass a pure staleness check before feeds recover; the grace period covers that gap.

#### G-35
`if (newSpent > dailyUsdTurnoverCap) revert TurnoverCapExceeded(spent, orderUsd, dailyUsdTurnoverCap);` · `OphisVaultPolicyModule.sol:527-533` · The economic bound on a compromised curator's churn.

#### G-36
`if (!success) revert ModuleExecFailed(to);` · `OphisVaultPolicyModule.sol:598` · A silently-failed Safe exec would leave an allowance set with no presignature, or a presignature with no allowance.

#### G-37
`if (!success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) revert ApproveFailed(token);` · `OphisVaultPolicyModule.sol:611-614` · Accepts both bool-returning and void-returning ERC20s while still rejecting an explicit `false`.

#### G-38
`if (feedDecimals > 18) revert UnsupportedFeedDecimals(address(feed));` · `OphisChainlinkFloor.sol:32` · Guards the `10 ** (18 - feedDecimals)` scaling from underflowing.

#### G-39
`if (answer <= 0) revert InvalidOraclePrice(address(feed));` · `OphisChainlinkFloor.sol:40` · A zero or negative answer would make the floor meaningless or invert it.

#### G-40
`if (updatedAt == 0 || answeredInRound < roundId) revert StaleOraclePrice(address(feed));` · `OphisChainlinkFloor.sol:45-47` · Rejects an incomplete round or an answer carried over from an earlier round, which a pure age check would still accept.

#### G-41
`if (block.timestamp > updatedAt + maxStaleness) revert StaleOraclePrice(address(feed));` · `OphisChainlinkFloor.sol:48-50` · The per-token freshness bound, sized to that feed's own heartbeat.

#### G-42
`if (owners[i] == cfg.curator) revert CuratorIsSafeOwner(cfg.curator);` · `OphisVaultPolicyModuleFactory.sol:44` · Deploy-time enforcement of the operational invariant; an owner-curator could exec raw approve and bypass the gate.

#### G-43
`if (cfg.safe.isModuleEnabled(cfg.curator)) revert CuratorIsSafeModule(cfg.curator);` · `OphisVaultPolicyModuleFactory.sol:46-48` · Strictly the more dangerous of the two, since an enabled module needs no signature threshold.

#### G-44
`require(msg.sender == timelock, "Guardian: caller not timelock")` · `AllowListGuardian.sol:70` · Confines every capability-adding op behind the 24h delay.

#### G-45
`require(msg.sender == guardian, "Guardian: caller not guardian")` · `AllowListGuardian.sol:75` · The fast defensive path; eviction of a compromised submitter must never be delayed.

#### G-46
`require(authenticator_ != address(0) && timelock_ != address(0) && guardian_ != address(0), "Guardian: zero address")` · `AllowListGuardian.sol:80-83` · `timelock` and `authenticator` are immutable, so a zero would be unrecoverable.

#### G-47
`require(newManager != address(0), "Guardian: zero manager")` · `AllowListGuardian.sol:104` · A fat-fingered zero here would brick the authenticator's manager role permanently.

#### G-48
`require(newGuardian != address(0), "Guardian: zero guardian")` · `AllowListGuardian.sol:112` · Preserves the fast eviction path across rotations.

---

## 2. Inferred Invariants (Single-Contract)

Inferred invariants are derived from structural analysis of the source. Each block cites one of five extraction methods in its `Derivation` field: Δ-pair analysis, guard lift, state-machine edge, temporal predicate, or NatSpec-stated global property. Each is classified by shape: `Conservation` · `Bound` · `Ratio` · `StateMachine` · `Temporal`.

---

#### I-1

`Conservation` · On-chain: **Yes**

> `liveAllowanceUid[t] == keccak256(liveAllowanceOrderUid[t])` for every sell token `t`, at every block.

**Derivation** — Δ-pair: `OphisVaultPolicyModule.sol:349` ↔ `OphisVaultPolicyModule.sol:350` (both written in the same basic block from the same `orderUid`/`key` pair) and `OphisVaultPolicyModule.sol:415` ↔ `OphisVaultPolicyModule.sol:416` (both deleted together). Write-site enumeration confirms these are the only two writers of either mapping.

**If violated** — `rebalance` would revoke the wrong predecessor's presignature, or `cancel` would zero an allowance belonging to a different order.

---

#### I-2

`Conservation` · On-chain: **Yes**

> `turnoverSpentUsd` and `lastTurnoverTs` are always advanced together; no path updates one without the other.

**Derivation** — Δ-pair: `OphisVaultPolicyModule.sol:534` ↔ `OphisVaultPolicyModule.sol:535`. The only other write to either is the constructor seeding `lastTurnoverTs = block.timestamp` at `:274` (with `turnoverSpentUsd` at its zero default).

**If violated** — the leaky bucket would either never drain (a permanent brick) or drain against a stale reference point (an unbounded budget).

---

#### I-3

`Bound` · On-chain: **Yes**

> `maxSlippageBps ∈ [0, 5000]` for the lifetime of the instance.

**Derivation** — guard-lift: G-4 (`cfg.maxSlippageBps > MAX_SLIPPAGE_BPS_CAP` → `BadConfig`, `:242`) lifted over write sites. `maxSlippageBps` is `immutable` with exactly one assignment at `:269`; no setter exists.

**If violated** — the floor band could widen toward a free-price order.

---

#### I-4

`Bound` · On-chain: **Yes**

> `maxTtl ∈ (0, 3600]` seconds for the lifetime of the instance.

**Derivation** — guard-lift: G-5 (`:243-244`) lifted over write sites. `maxTtl` is `immutable`, single assignment at `:270`.

**If violated** — the presign-vs-fill window would lengthen, widening the disclosed intra-TTL adverse-move residual.

---

#### I-5

`Bound` · On-chain: **Yes**

> `dailyUsdTurnoverCap > 0` for the lifetime of the instance.

**Derivation** — guard-lift: G-6 (`:245`) lifted over write sites. `immutable`, single assignment at `:271`.

**If violated** — every rebalance would revert, or the economic bound would vanish.

---

#### I-6

`Bound` · On-chain: **Yes**

> `appDataHash != bytes32(0)` for the lifetime of the instance.

**Derivation** — guard-lift: G-2 (`:239`) lifted over write sites. `immutable`, single assignment at `:268`.

**If violated** — orders carrying an empty appData would pass G-26, dropping the partner fee.

---

#### I-7

`Bound` · On-chain: **Yes**

> Every allowlisted token has `tokenDecimals <= 36` and `maxStaleness ∈ (0, 2 days]`.

**Derivation** — guard-lift: G-12 (`:290-292`) and G-14 (`:295-297`) lifted over write sites. `tokenPolicy[...]` has exactly one write site, `:302`, inside the constructor loop, guarded by both. Grep confirms no setter and no other assignment anywhere in scope.

**If violated** — the floor math could overflow (bricking rebalances) or consume arbitrarily stale prices.

---

#### I-8

`Bound` · On-chain: **Yes**

> After any successful `rebalance`, `turnoverSpentUsd <= dailyUsdTurnoverCap`.

**Derivation** — guard-lift: G-35 (`:527-533`) lifted over write sites. `turnoverSpentUsd` has exactly one write site, `:534`, immediately preceded by the guard in the same basic block.

**If violated** — the instantaneous burst bound on a compromised curator would not hold.

---

#### I-9

`Temporal` · On-chain: **Yes**

> The turnover accumulator drains at `dailyUsdTurnoverCap` per day: `leaked = (block.timestamp - lastTurnoverTs) * dailyUsdTurnoverCap / 1 days`, floored at a zero balance.

**Derivation** — temporal: `uint256 elapsed = nowTs - lastTurnoverTs; uint256 leaked = (elapsed * dailyUsdTurnoverCap) / 1 days;` (`OphisVaultPolicyModule.sol:521-522`), applied checked-then-updated (`:534-535`), so no stale-read window exists.

**If violated** — the bucket would drain faster or slower than the advertised rate.

---

#### I-10

`Bound` · On-chain: **No**

> Over any rolling 24h window the module admits at most ~2x `dailyUsdTurnoverCap` of sell-side turnover.

**Derivation** — NatSpec: `OphisVaultPolicyModule.sol:26-30` — *"over any ROLLING 24h it admits at most ~2x the cap (spend the full cap, then re-spend it as the bucket drips back over the next 24h). This is the inherent burst allowance of any O(1) rate limiter."* The structural scan confirms the code enforces only the instantaneous bucket bound (I-8); the ~2x rolling figure is an analytical consequence of the leak rate, not a checked predicate.

**If violated** — nothing on-chain would detect it; the operator guidance to size the cap at half the true 24h tolerance is what carries this property.

---

#### I-11

`Temporal` · On-chain: **Yes**

> Every presigned order satisfies `block.timestamp < validTo <= block.timestamp + maxTtl` at presign time.

**Derivation** — temporal: `if (order.validTo <= block.timestamp || order.validTo > block.timestamp + maxTtl) revert BadValidTo();` (`OphisVaultPolicyModule.sol:453-456`).

**If violated** — an already-expired or arbitrarily long-lived order could be presigned.

---

#### I-12

`Temporal` · On-chain: **Yes**

> Every price consumed by the floor satisfies `block.timestamp <= updatedAt + maxStaleness` and comes from a complete round.

**Derivation** — temporal: `if (block.timestamp > updatedAt + maxStaleness) revert StaleOraclePrice(address(feed));` (`OphisChainlinkFloor.sol:48-50`), combined with the round-completeness guard G-40 at `:45-47`. `read18` is the only price reader in scope (`OphisVaultPolicyModule.sol:301, 464, 473`).

**If violated** — the floor would be struck against a stalled feed.

---

#### I-13

`StateMachine` · On-chain: **Yes**

> `moduleOrderSellToken[key]` cycles `address(0) → sellToken → address(0)`; only the `sellToken` state is cancellable.

**Derivation** — edge: `address(0)@:347 → sellToken@:347` (set in `rebalance`) and `sellToken@:393 → address(0)@:395` (cleared in `cancel`, gated by G-18) plus `sellToken → address(0)@:348` (cleared on same-token supersession). This is a cycle rather than a one-shot latch: a re-presigned order receives a fresh entry, as the NatSpec at `:394` states.

**If violated** — `cancel` could act on uids this module never created, or a live order could become uncancellable.

---

#### I-14

`Bound` · On-chain: **Yes**

> At most one live module-created order per sell token, and the Safe's relayer allowance for that token equals that order's exact pull amount.

**Derivation** — guard-lift: G-19 (`:414`) lifted over write sites. `liveAllowanceUid[sellToken]` is a single slot with exactly two writers (`:349` overwrite, `:415` delete); `_approveAndPresign` (`:557-575`) resets the allowance to zero and then to the exact amount on every rebalance, so the allowance is repointed in lockstep with the slot.

**If violated** — a superseded order could retain a fillable allowance, doubling the exposure per token.

---

#### I-15

`Bound` · On-chain: **No**

> The curator is neither a current Safe owner nor an enabled Safe module.

**Derivation** — guard-lift: G-9 (`OphisVaultPolicyModule.sol:263`) and G-42/G-43 (`OphisVaultPolicyModuleFactory.sol:44-48`) lifted over write sites. Write-site enumeration is the finding: the constrained state (the Safe's owner set and module set) lives entirely in the **Safe**, which this module never reads again after construction. There is no runtime re-check on `rebalance` or `cancel`. The NatSpec discloses this explicitly at `:72-74` — *"keeping it un-ownered / un-moduled over time (owners/modules can drift post-deploy) is the vault owners' responsibility."*

**If violated** — the curator gains a Safe path that bypasses the policy gate entirely, and every guarantee downstream of it collapses. This is the module's single load-bearing off-chain assumption.

---

#### I-16

`Bound` · On-chain: **Yes**

> Every accepted order cleared a strictly positive oracle floor.

**Derivation** — guard-lift: G-30 (`:484`) lifted over the accept path. `oracleFloor` is assigned once at `:469-480` and the guard sits between that assignment and the only accept path (`:488-490`), before any state write.

**If violated** — an order whose value rounds below one base unit of the buy token could be presigned with effectively no floor.

---

#### I-17

`Ratio` · On-chain: **Yes**

> `oracleFloor = ⌊⌊sellAmount · pSell18 · 10^buyDec / (pBuy18 · 10^sellDec)⌋ · (BPS − slippageBps) / BPS⌋`

**Derivation** — Ratio: `OphisChainlinkFloor.sol:74-77`. Both divisions truncate toward zero, so the computed floor rounds **down** — i.e. marginally in the counterparty's favour, bounded by one base unit of the buy token plus the slippage scaling. The multiplication is deliberately ordered before the division (single expression) so small sells into higher-decimal buy tokens do not truncate to zero prematurely; G-30 catches the residual zero case.

**If violated** — the floor would not correspond to the oracle cross-rate.

---

#### I-18

`Ratio` · On-chain: **Yes**

> `orderUsd = sellAmount · sellPrice18 / 10^sellTokenDecimals`, computed from the same `sellPrice18` snapshot the floor used.

**Derivation** — Ratio: `OphisVaultPolicyModule.sol:493-495`, consuming the `sellPrice18` read once at `:464-468`. The snapshot is taken before any state write in the call, so the floor and the turnover charge cannot diverge on price within one transaction.

**If violated** — the turnover bucket would be charged at a different price than the floor was struck at.

---

#### I-19

`Bound` · On-chain: **Yes**

> `requiredFloor = max(oracleFloor, minBuyOverride)` — a curator-supplied override can only tighten the floor, never loosen it.

**Derivation** — guard-lift: G-31 (`:488-490`) lifted, with the max selection at `:485-487`. `minBuyOverride` is a calldata parameter with no storage write site, so the property holds per call by construction and G-30 independently blocks the `oracleFloor == 0` bypass.

**If violated** — the curator's own parameter would become a way to widen the price band.

---

#### I-20

`Bound` · On-chain: **Yes**

> `AllowListGuardian.guardian != address(0)` at every block.

**Derivation** — guard-lift: G-46 (`AllowListGuardian.sol:80-83`) and G-48 (`:112`) lifted over write sites. `guardian` has exactly two write sites — `:86` (constructor, guarded by G-46) and `:114` (`setGuardian`, guarded by G-48) — and both enforce the bound.

**If violated** — the fast defensive eviction path would be permanently unreachable.

---

#### I-21

`Bound` · On-chain: **Yes**

> `AllowListGuardian.timelock` and `.authenticator` are immutable and non-zero.

**Derivation** — guard-lift: G-46 (`:80-83`) lifted. Both are `immutable` with single assignments at `:84-85`; no setter exists.

**If violated** — the slow path could be redirected or bricked.

---

#### I-22

`Bound` · On-chain: **Yes**

> `OphisVaultPolicyModule` has no post-deploy configuration surface: every policy parameter has exactly one write site, in the constructor.

**Derivation** — guard-lift over the full write-site enumeration. `safe`, `settlement`, `relayer`, `domainSeparator`, `curator`, `appDataHash`, `maxSlippageBps`, `maxTtl`, `dailyUsdTurnoverCap`, `sequencerUptimeFeed`, `sequencerGracePeriod` are all `immutable` (`:126-149`), assigned once at `:265-280`. `tokenPolicy` has one write site at `:302`. Grep across the scope files confirms zero setter functions and zero `onlyOwner`/`onlyAdmin` modifiers on the module.

**If violated** — the policy could be widened after depositors relied on it.

---

#### I-23

`Temporal` · On-chain: **Yes**

> On the runtime path, no price is consumed while the sequencer is down, in an uninitialized round, or within `sequencerGracePeriod` of recovery.

**Derivation** — temporal: `if (block.timestamp - startedAt < sequencerGracePeriod) revert SequencerStarting();` (`OphisVaultPolicyModule.sol:508-510`), invoked at `:461` **before** the first `read18` at `:464`. Ordering verified: `_checkSequencer()` precedes both feed reads in `_enforcePolicy`.

**If violated** — a pre-outage price could be consumed inside the window where feeds have not yet recovered. See X-4 for the one path where this ordering does not hold.

---

**Categories:**
- **Conservation**: two or more storage variables change by equal-and-opposite (or lockstep) amounts in the same function body.
- **Bound**: a guard on a storage variable, lifted to a global property and checked across every write site of that variable.
- **Ratio**: a storage or returned value defined as a formula of other values.
- **StateMachine**: a variable transitioning through discrete values with guards on the edges.
- **Temporal**: a condition depending on `block.timestamp` or a stored duration/deadline.

---

## 3. Inferred Invariants (Cross-Contract)

Trust assumptions spanning contract boundaries. Each block cites both caller-side and callee-side code, both inside the scope files.

---

#### X-1

On-chain: **Yes**

> The module assumes every `read18` return value is a strictly positive, complete-round, fresh price already scaled to 18 decimals.

**Caller side** — `OphisVaultPolicyModule.sol:464-468` and `:473-477` — the returned `sellPrice18` / buy price feed directly into `floorBuyAmount` and, for the sell leg, into the turnover charge at `:493-495`. Neither return value is re-validated by the caller.

**Callee side** — `OphisChainlinkFloor.sol:27-52` — the only write-free path out of `read18` passes G-38 (feed decimals), G-39 (`answer <= 0`), G-40 (round completeness), and G-41 (age). Every failure reverts; there is no fallback return.

**If violated** — the floor would be struck against an invalid or stale price with no caller-side backstop.

---

#### X-2

On-chain: **Yes**

> The module assumes `floorBuyAmount` may legitimately return zero and guards that case itself rather than delegating it.

**Caller side** — `OphisVaultPolicyModule.sol:484` — `if (oracleFloor == 0) revert ZeroOracleFloor();` sits between the computation and the comparison, and fires regardless of `minBuyOverride`.

**Callee side** — `OphisChainlinkFloor.sol:74-77` — the two truncating divisions can reach zero for an order whose value is below one base unit of the buy token; the library has no non-zero postcondition and deliberately does not assert one.

**If violated** — a near-zero-proceeds order would clear a zero floor whenever the curator supplied any non-zero `minBuyOverride`.

---

#### X-3

On-chain: **Yes**

> The factory's curator-privilege rejection is re-asserted by the module rather than trusted.

**Caller side** — `OphisVaultPolicyModuleFactory.sol:42-48` — iterates `cfg.safe.getOwners()` and calls `cfg.safe.isModuleEnabled(cfg.curator)` before `new OphisVaultPolicyModule(cfg)` at `:50`.

**Callee side** — `OphisVaultPolicyModule.sol:263` → `:582-588` — `_requireCuratorNotPrivileged` repeats both checks in the constructor, so a direct deploy that bypasses the factory cannot skip them. The NatSpec at `:262` states this intent explicitly.

**If violated** — a module deployed outside the factory could ship with a privileged curator.

---

#### X-4

On-chain: **No**

> The deploy-time feed liveness probe is assumed to be at least as strict as the runtime price path.

**Caller side** — `OphisVaultPolicyModule.sol:301` — the constructor loop calls `OphisChainlinkFloor.read18(feed, feedDecimals, staleness)` directly as a fail-closed liveness probe, with no preceding `_checkSequencer()`.

**Callee side** — `OphisVaultPolicyModule.sol:502-511` — `_checkSequencer` is a `view` function reading only the `sequencerUptimeFeed` immutable, which is already assigned at `:272`, i.e. before the token loop begins at `:283`. The runtime path calls it at `:461` before its first `read18`; the constructor path does not.

**If violated** — a module deployed on an L2 inside the post-recovery grace window can pass its liveness probe against a price the runtime gate would reject. The impact is bounded: the probe result is not persisted, and every subsequent `rebalance` re-applies the full gate, so this weakens a deploy-time sanity check rather than opening a runtime bypass.

---

## 4. Economic Invariants

Higher-order properties derived from combinations of §2 and §3. Every block traces back to concrete invariant IDs.

---

#### E-1

On-chain: **Yes**

> Every order this module presigns pays its proceeds to the vault Safe.

**Follows from** — G-24 (receiver pin) + `I-22` (no post-deploy config surface can relax it) + `I-19` (the curator's only price parameter tightens).

**If violated** — the module's custody story fails at its most basic level.

---

#### E-2

On-chain: **No**

> A compromised curator key cannot drain the vault; its worst-case damage is bounded price bleed within the floor band.

**Follows from** — `E-1` + `I-8` + `I-16` + **`I-15`**.

**If violated** — the headline guarantee fails. The derivation is On-chain=No solely because `I-15` is: the curator-not-privileged property is enforced at construction and at factory deploy, but never re-checked at runtime, and the constrained state lives in the Safe. Given `I-15` holds, every other link in the chain is on-chain-enforced.

---

#### E-3

On-chain: **Yes**

> The vault's net receipt is at least the struck oracle floor, notwithstanding the Ophis partner fee.

**Follows from** — `I-16` + `I-19` + G-25 (`feeAmount == 0`, so no fee is deducted from the signed amounts) + the settlement's own enforcement that a fill-or-kill sell order executes at or above its signed `buyAmount`. The partner fee rides in appData (G-26) and is taken from surplus above the signed limit, not from the limit itself.

**If violated** — the floor would be a gross figure the vault never actually receives.

---

#### E-4

On-chain: **No**

> Worst-case bleed over any rolling 24h is bounded by `~2 · dailyUsdTurnoverCap · (maxSlippageBps/1e4 + fees + intra-TTL drift)`.

**Follows from** — `I-8` + `I-10` + `I-17` + `I-4`.

**If violated** — the quoted operational bound would not hold. On-chain=No for two reasons: `I-10`'s rolling-window figure is analytical rather than checked, and the `intra-TTL drift` term is the disclosed Phase-B residual #1 — the floor binds at presign time, not at fill time, so the term is bounded by `maxTtl` (`I-4`) rather than eliminated.

---

#### E-5

On-chain: **Yes**

> Turnover charged is always greater than or equal to turnover that can actually settle.

**Follows from** — `I-8` + `I-13` + `I-14`.

Every `rebalance` charges the full sell-side USD value at `:334` before any presignature exists, and supersession (`:341-366`) charges the successor **without** refunding the superseded order it revokes. The bucket therefore over-counts relative to fillable exposure. The direction is conservative: the effective economic bound is stricter than advertised, never looser.

**If violated** — the cap could be under-charged and the bound in `E-4` would not hold.
