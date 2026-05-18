# Phase 2 Backend Audit — 2026-05-18

**Scope:** `apps/backend/crates/{autopilot, driver, orderbook, solvers}`
**Out of scope:** contracts (Phase 1), eRPC config (covered yesterday), bootstrap `.expect()` sites (PR #72/#73/#78), HL hook gas cap (PR #75), `ignoreFields:[timestamp]` (PR #71).

**Method:** 4-reviewer convergence — `sharp-edges-analyzer` + `silent-failure-hunter` + `adversarial-modeler` + Codex Cyber (gpt-5.3-codex trusted-cyber). Each reviewer independently swept the full scope.

**Convergence rule:** Findings flagged by ≥2 reviewers are HIGH-confidence regardless of any single reviewer's severity rating.

---

## Top-line summary

- **Total deduplicated findings:** 32
- **HIGH severity:** 9 (4 cross-reviewer convergence, 5 unique high-confidence)
- **MED severity:** 15
- **LOW severity:** 8
- **Status:** zero findings have been validated as exploitable end-to-end yet; this is the audit synthesis. The next workflow step is per-finding `fp-check`-style false-positive elimination before PR drafting.

---

## CONVERGENCE LAYER — multi-reviewer hits (HIGH confidence)

### C1. Partner-fee `priceImprovementBps` is not capped against CIP-75's 2500-bps ceiling

- **Severity:** HIGH
- **Reviewers:** sharp-edges (F2) · adversarial-modeler (F1) · silent-failure-hunter (F6, inverse failure mode)
- **Location:**
  - `autopilot/src/domain/fee/mod.rs:204, 211-234` — `factor = fee_factor_from_bps(bps)` with no policy-side clamp on the `Surplus`/`PriceImprovement` arms
  - `autopilot/src/domain/fee/mod.rs:161-166` — `fee_factor_from_bps` clamps only to `MAX_BPS - 1` (= 9999 bps = 99.99%)
  - `app-data/src/app_data.rs:271-288` — `Validator::validate` enforces JSON shape only, no semantic bps cap
  - `shared/src/order_validation.rs:565-616` — no app-data partner-fee validation hook
- **Issue:** CIP-75 specifies `priceImprovementBps ≤ 2500` as a protocol-level invariant. The codebase enforces this nowhere — only an aggregate `max_partner_fee` (default 0.01) is applied, and only on the `max_volume_factor` arm. An attacker (or even a careless legitimate integrator) can stuff `priceImprovementBps: 9999` into app-data and capture ~100 % of price improvement on every order signed against that hash.
- **Inverse failure mode (silent-failure F6):** three `let Ok(...) else { return vec![]; }` early-returns in `get_partner_fee` (mod.rs:168-176) drop ALL partner fees silently when app-data is unparseable. This is the same surface, opposite direction — the bps is wide open on the upside, silently zeroed on the downside, with zero telemetry for either case.
- **Recommended fix:** ① Hard clamp `priceImprovementBps` to a `MAX_PARTNER_FACTOR_BPS = 2500` constant in `get_partner_fee()`. ② Reject orders in `validate_app_data()` where any `partner_fee[].bps > 2500`. ③ Promote the three early-return sites in mod.rs:168-176 to `tracing::error!` + `partner_fee_dropped_total{reason}` metric. ④ Unit test asserting clamp behavior at 2500 / 2501 / 9999 / `u64::MAX` boundaries.

---

### C2. Solver-controlled allowances enable settlement-fund drain (general case + OKX-specific surface)

- **Severity:** HIGH
- **Reviewers:** Codex Cyber (F1, general case) · sharp-edges (F1, OKX specific) · adversarial-modeler (F2, OKX specific)
- **Location:**
  - **General (Codex):** `driver/src/infra/solver/dto/solution.rs:162`, `driver/src/domain/competition/solution/interaction.rs:36`, `driver/src/domain/competition/solution/mod.rs:461`, `driver/src/domain/competition/solution/encoding.rs:171`
  - **OKX (specific instance):** `solvers/src/infra/dex/okx/mod.rs:201-227, 283, 335`
  - **Contrast (already hardened):** `solvers/src/infra/dex/kyberswap/mod.rs:34-75` and `solvers/src/infra/dex/velora/mod.rs:62-120` — both gate `routerAddress` and `contractAddress` against static `ALLOWLIST` per chain
- **Issue:** Codex's framing is the right one: at the driver level, `Interaction::Custom.allowances` is treated as trusted solver output and round-tripped into on-chain approvals. The OKX-specific finding is one concrete instance of the general problem — every existing DEX integration that supplies its own router via API response is structurally drainable if the upstream is compromised (DNS hijack, CDN worker, API key exfil, BGP). KyberSwap and Velora have hand-rolled allowlists; OKX does not; new integrations are likely to repeat the OKX mistake.
- **Attack path:** Compromised upstream → returns attacker-controlled `tx.to` + `spender` → driver grants approval → calldata pulls tokens. If any user has standing `approve(settlement, > 0)` allowances (CoW-AMMs, pending orders), those drain in the same batch.
- **Recommended fix (two layers):**
  1. **Per-DEX (immediate, S size):** Add `OKX_ROUTER_ALLOWLIST` keyed by `chain_id` to `solvers/src/infra/dex/okx/mod.rs`, mirroring the KyberSwap/Velora pattern verbatim. Reject any `tx.to` or `dex_contract_address` not on the list.
  2. **Driver-level invariant (M size):** Add a policy layer in driver that allowlists `Custom.target` + `allowances.spender` per chain, caps allowance amounts (no `U256::MAX` from solver), and asserts that decoded calldata selectors are consistent with declared inputs/outputs/allowances.

---

### C3. Partner-fee `recipient` is fully attacker-controlled — no allowlist binds it to `appCode`

- **Severity:** HIGH
- **Reviewers:** sharp-edges (F3) · adversarial-modeler (F6)
- **Location:**
  - `app-data/src/app_data.rs:87-93` — `PartnerFee.recipient: Address` parsed verbatim, no validation
  - `autopilot/src/domain/fee/mod.rs:180-237` — recipient round-trips through accounting but the domain `Policy::*` enum carries no recipient field, so identity is not enforced at encoding time
- **Issue:** The Ophis partner-fee Safe `0x858f0F5e…cF8` is referenced socially, not cryptographically. Any order signer can paste any address into `partnerFee[].recipient` and reference the legitimate `appCode = "CoW Swap"`. Combined with C1, the partner-fee exfil pathway is fully open: attacker app-data with `priceImprovementBps: 9999, recipient: <attacker_addr>` extracts ~100 % improvement to a non-Ophis address.
- **Recommended fix:** Maintain an on-chain (or config-side) registry of `appCode → permitted_recipient[]`. Reject orders in `validate_app_data()` whose `partner_fee[].recipient` is not registered for the order's `appCode`. Persist `recipient` on the `Policy` enum and re-check at encoding time. Pair with C1 fix into a single CIP-75-enforcement PR.

---

### C4. Driver `tx_gas_limit` & gas-fee override paths trust solver/RPC without bounds

- **Severity:** MED
- **Reviewers:** sharp-edges (F4, F5, F6) · adversarial-modeler (F4)
- **Location:**
  - `driver/src/domain/mempools.rs:383-408` — `apply_gas_fee_override` replaces `max_fee_per_gas` with solver-supplied `u128` post-cap
  - `driver/src/infra/blockchain/gas.rs:120-128` — RPC `max_priority_fee_per_gas` only bounded against `gas_price_cap` (default 1000 gwei), not against historical p99
  - `driver/src/infra/config/file/mod.rs:83-84` — `tx_gas_limit: eth::U256` no `#[serde(default)]`, no range check
  - `driver/src/infra/config/file/mod.rs:318` — `haircut_bps: u32` accepts up to 4e9, no clamp to MAX_BPS
- **Issue:** Three related gas-related trust-boundary slips. ① A malicious solver can supply `max_fee_per_gas = u128::MAX` via `GasFeeOverride` and drain the submitter EOA. ② A hostile RPC can return `max_priority_fee_per_gas = 999_999_999_999` (just below the cap) and the driver pays it. ③ Operator can set `tx_gas_limit = 0` or `100_000_000` with no validation — directly defeats the hardcoded HL hook-gas cap (PR #75). ④ `haircut_bps` overflow (4e9) silently produces negative surplus.
- **Recommended fix:** ① Clamp solver `GasFeeOverride` to `mempool.gas_price_cap`. ② Sanity-bound RPC `max_priority_fee_per_gas` against rolling p99 × 3. ③ Validate `tx_gas_limit ∈ [1_000_000, block_gas_limit(chain_id)]` at config load; derive HL `max_per_hook_gas` from `tx_gas_limit`, not a magic constant. ④ Wrap `_bps` fields in a `Bps(u16)` newtype with deserialization clamp.

---

## UNIQUE HIGH-confidence findings

### H1. Driver `SubmissionError` collapse erases all failure-mode information

- **Severity:** HIGH
- **Reviewer:** silent-failure-hunter (F1)
- **Location:** `driver/src/domain/competition/mod.rs:948-949` (`Err(_) => Err(Error::SubmissionError)`); `driver/src/infra/observe/mod.rs:458`
- **Issue:** All mempool errors (revert, expired, stuck-nonce, RPC drop, signer-not-found) collapse to a single opaque `SubmissionError`. On HyperEVM single-upstream, this is the alerting backbone — and it is structurally blind. Operators cannot tell a transient RPC blip from a stuck nonce.
- **Fix:** Widen to `SubmissionError(SubmissionFailureKind { Revert, Expired, GasStuck, Rpc, NonceConflict, Cancelled })`. Wire to `submission_error_total{kind, chain}` metric.

### H2. Driver mempool cancellation failure silently discarded → stuck-nonce death spiral

- **Severity:** HIGH
- **Reviewer:** silent-failure-hunter (F2)
- **Location:** `driver/src/domain/mempools.rs:234-236, 251-253` (`let _ = self.cancel(...)`)
- **Issue:** Failed cancellation = stuck nonce on the submitter EOA. On HyperEVM (no fallback mempool), this halts settlement for that signer until manual intervention. No signal beyond timing anomalies on subsequent auctions.
- **Fix:** `if let Err(err) = self.cancel(...).await { tracing::error!(?err, ?signer, ?nonce, "cancellation failed — signer nonce may be stuck"); }` + `submitter_cancellation_failed{signer, chain}` metric → PagerDuty.

### H3. Autopilot run-loop ticks liveness on stale/empty auctions

- **Severity:** HIGH
- **Reviewer:** silent-failure-hunter (F3)
- **Location:** `autopilot/src/run_loop.rs:244-247, 274, 297-298`
- **Issue:** `solvable_orders_cache.update()` failures are warn-logged; the loop proceeds with stale view, and `probes.liveness.auction()` still ticks. A persistent indexer/DB outage produces a green liveness probe and a steady stream of empty auctions while CIP-75 reference quotes run against stale prices.
- **Fix:** Gate liveness behind a staleness check. After N consecutive cache-update failures, flip liveness to false. Promote to `tracing::error!` after the first failure.

### H4. Driver `/healthz` returns 200 unconditionally — k8s sees green during full outage

- **Severity:** HIGH
- **Reviewer:** silent-failure-hunter (F4)
- **Location:** `driver/src/infra/api/routes/healthz.rs:11-13` (`async fn route() -> Response { StatusCode::OK.into_response() }`)
- **Issue:** No checks on upstream RPC, submitter EOA balance, chain-id mismatch. Driver advertises healthy while it cannot reach HyperEVM, cannot read submitter nonce, or has a depleted EOA.
- **Fix:** Probe must verify ① `eth.current_block()` is fresh (< 30s old), ② submitter EOA balance > min threshold, ③ chain_id from RPC matches config. Return 503 + JSON body naming the failed subsystem on any failure.

### H5. Autopilot maintenance silent-rollback breaks block-processing chain

- **Severity:** HIGH
- **Reviewer:** silent-failure-hunter (F5)
- **Location:** `autopilot/src/maintenance.rs:64-66, 166-170, 188-191`
- **Issue:** `wait_until_block_processed` swallows timeouts at `tracing::debug!`. Settlement indexer stuck → autopilot competes on stale settlement state → drivers may try to re-settle already-filled orders → `SimulationRevert`.
- **Fix:** Promote line 65 to `tracing::warn!` with target block + elapsed time; `maintenance_wait_timeout_total` metric. On essential-maintenance failure, increment a separate counter that flips liveness if monotonic.

---

## MED-severity findings (single-reviewer, action recommended)

| ID | Reviewer | Location | Summary |
|---|---|---|---|
| M1 | sharp-edges F7 | `driver/src/domain/competition/mod.rs:896-933` | Settlement removed from cache before submission lock acquired → unrecoverable on lock-acquire failure |
| M2 | sharp-edges F8 | `driver/src/domain/competition/mod.rs:87, 149` | `tokio::sync::Mutex<mpsc::Receiver>` deadlock cliff for EIP-7702 pool |
| M3 | sharp-edges F9 | `autopilot/src/infra/persistence/mod.rs:82-95` | Unbounded mpsc for DB auction uploads → OOM under DB stress |
| M4 | sharp-edges F10 | `driver/src/infra/solver/dto/solution.rs:368` | EIP-1271 signature slice panics on `signature.len() < 20` |
| M5 | sharp-edges F11 + adversarial F3 | `driver/src/infra/config/file/mod.rs:357-370` | Submitter PK stored as plaintext TOML field, not file-path reference. Contradicts Tier 1 PK isolation model. |
| M6 | adversarial F5 | `winner-selection/src/arbitrator.rs:61-104, 644-662` | Combinatorial baseline poisonable by single-pair high-score attacker solution |
| M7 | Codex F2 | `driver/src/domain/competition/solution/settlement.rs:247` | Access-list estimation fail-open on RPC errors |
| M8 | silent-failure F7 | `orderbook/src/database/fee_policies.rs:80-86` | Fee-policy lookup miss silently excludes executed protocol fee (warn-only "possibly JIT?") |
| M9 | silent-failure F8 | `autopilot/src/infra/persistence/mod.rs:84-95, 161-166` | Persistence upload-task channel `.expect("alive at all times")` → autopilot panic on shutdown race |
| M10 | silent-failure F9 | `solvers/src/infra/dex/kyberswap/mod.rs:265-274` + `velora/mod.rs:374-383` | Slippage clamped to MAX silently — user-facing economic divergence |
| M11 | silent-failure F10 | `solvers/src/infra/dex/okx/mod.rs:422, 430, 434, 444, 448` | OKX request-build errors collapsed to opaque `RequestBuildFailed(no source)` |
| M12 | silent-failure F11 | `driver/src/domain/mempools.rs:259` | Re-simulation failure during in-flight tx tracking warn-and-continues |
| M13 | silent-failure F12 | `autopilot/src/run_loop.rs:870-877` | Settlement-tx lookup DB errors swallowed in poll loop → DB outage masquerades as solver timeout |
| M14 | silent-failure F13 | `driver/src/infra/solver/mod.rs:383-388` | Auction-deadline-exceeded solver request returns empty `Default::default()` — no metric, no distinction from "solver found nothing" |
| M15 | silent-failure F14 | `orderbook/src/api/cancel_orders.rs:21-23` | `/cancel_orders` BAD_REQUEST returns no body, no logging |
| M16 | silent-failure F15 | `autopilot/src/database/onchain_order_events/mod.rs:714-717` | Onchain-order app-data parse failure silently drops `hooks.pre`/`hooks.post` |

---

## LOW-severity findings

| ID | Reviewer | Location | Summary |
|---|---|---|---|
| L1 | sharp-edges F12 | `driver/src/infra/config/file/mod.rs:233-235, 385-386` | `solving_share_of_deadline: f64` accepts NaN/∞/negative |
| L2 | adversarial F7 | `driver/src/infra/mempool/mod.rs:122-181` | Settlement broadcast is single-upstream, public-mempool by default → MEV trivial. Intentional per ops context; document. |
| L3 | adversarial F8 | `app-data/src/hooks.rs:30-38`; `shared/src/order_validation.rs:362-394` | Hook `target` is unrestricted — defense-in-depth concern. Add per-chain denylist for protocol contracts + multisigs. |
| L4 | silent-failure F16 | `autopilot/src/infra/persistence/mod.rs:920-923` | JIT-order missing trade event → silently drop from `/solver_competition` |
| L5 | silent-failure F17 | `orderbook/src/ipfs.rs:38, 48-49` | IPFS fetch can't distinguish outage from not-found (both → `Ok(None)`) |
| L6 | silent-failure F18 | `autopilot/src/infra/persistence/mod.rs:692-700` | Quote-conversion failure: order kept in solvable set without quote → CIP-75 ref-price math runs against `U256::ZERO` silently |
| L7 | silent-failure F19 | `driver/src/domain/mempools.rs:137-141` | Pre-submission `estimate_gas` non-revert error warn-and-continues |
| L8 | silent-failure F20 | `driver/src/domain/mempools.rs:361-365` | Driver replacement-gas inspection failure silently falls back to current price → post-restart underpricing |
| L9 | Codex F3 | `orderbook/src/quoter.rs:96` | `app_data.find(&hash)` errors swallowed via `unwrap_or(None)` → mispriced quotes during IPFS outage |

---

## In-code TODO triage (roadmap 5.1, 29 TODOs in scope)

Categorized after scan:

- **CoW-upstream parity (10):** doc-comments and refactoring TODOs inherited from `cowprotocol/services`. Examples: `driver/src/infra/solver/mod.rs:46, 192`, `driver/src/domain/competition/solution/encoding.rs:32, 180`, `driver/src/domain/competition/order/signature.rs:14`. Not blocking. Track upstream resolutions before independent action.
- **Surplus-token accounting (3, real concern):** `autopilot/src/domain/settlement/mod.rs:129, 170`, `autopilot/src/domain/settlement/trade/mod.rs:180`, `orderbook/src/database/orders.rs:734`. All marked `// TODO surplus token` and currently use hardcoded `ByteArray([1; 20])` for the executed_fee_token field. Risk: surplus-fee analytics distort, partner-fee dashboards may misattribute. **Promote to its own ticket.**
- **Type-level guarantees (4):** `solvers/src/domain/solution.rs:231, 442`, `solvers/src/domain/solver/baseline.rs:371`, `driver/src/domain/competition/order/mod.rs:177` — known invariants enforced runtime-only. Tech debt, not actively dangerous.
- **Deployment cleanup (4):** `driver/src/infra/blockchain/contracts.rs:22, 94`, `driver/src/domain/liquidity/mod.rs:1`, `driver/src/domain/competition/solution/encoding.rs:32` — guards for "when contracts are deployed everywhere". Now that mainnet contracts are live (Phase 1), these can be cleaned up.
- **Detection-logic stubs (1):** `autopilot/src/solvable_orders.rs:597` — `// TODO: replace with proper detection logic`. Worth a sharp-edges deeper look in a follow-up.
- **Cosmetic (7):** stable-once-crate-stabilizes, naming TODOs, slippage doc TODOs. Skip.

**Recommendation:** spin up a single **PR-of-cleanups** for the deployment-cleanup category (4 TODOs) + a separate **surplus-token-correctness ticket** for the 3-site cluster. The rest stay as backlog.

---

## Suggested PR batching (for next sessions)

Each PR follows the 4-reviewer convergence pattern (sharp-edges + silent-failure-hunter + adversarial-modeler + Codex Cyber) before merge per `feedback_audit_mainnet_contract_wiring`.

### Sprint 1 — CIP-75 enforcement (the partner-fee killer chain)

**PR A: Hard-clamp `priceImprovementBps` to 2500 + reject in validator (C1)**
- Files: `autopilot/src/domain/fee/mod.rs`, `app-data/src/app_data.rs`, `shared/src/order_validation.rs`
- Tests: unit at clamp boundaries; integration via orderbook API rejection
- Risk: low — only tightens existing behavior

**PR B: Partner-fee recipient allowlist tied to appCode (C3)**
- Files: `app-data/src/app_data.rs` (new registry), `autopilot/src/domain/fee/mod.rs` (recipient persistence on Policy)
- Tests: rejection of mismatched recipient/appCode pairs
- Risk: medium — requires defining the initial allowlist; need Clement to confirm `0x858f0F5e…cF8` is the only legitimate Ophis recipient today
- **Blocker:** asks Clement to confirm partner-fee recipient registry initial entries

**PR C: Promote partner-fee silent drops to error + telemetry (C1 inverse)**
- Files: `autopilot/src/domain/fee/mod.rs:168-176`
- Tests: assert metric increments on each failure mode

### Sprint 2 — Driver trust-boundary hardening

**PR D: OKX router/spender allowlist (C2 layer 1)**
- Files: `solvers/src/infra/dex/okx/mod.rs`
- Tests: mock OKX response with non-allowlisted router → reject

**PR E: Driver-level Custom-interaction policy layer (C2 layer 2)**
- Files: `driver/src/infra/solver/dto/solution.rs`, `driver/src/domain/competition/solution/{interaction,encoding,mod}.rs`
- Tests: malicious-solver fixture supplying out-of-allowlist `Custom.target`
- Risk: high blast radius — touches solver protocol; needs careful rollout

**PR F: Gas trust-boundary (C4)**
- Files: `driver/src/domain/mempools.rs`, `driver/src/infra/blockchain/gas.rs`, `driver/src/infra/config/file/mod.rs`
- Tests: solver-supplied `u128::MAX` override → clamped to cap

### Sprint 3 — Operational visibility (the silent-failure cluster)

**PR G: Driver `SubmissionError` taxonomy (H1)** + **mempool cancellation telemetry (H2)** — bundled, same domain
**PR H: Autopilot liveness gating (H3 + H5)** — bundled, both are run-loop-level
**PR I: Driver real healthz probe (H4)**

### Sprint 4 — MED cluster cleanups

PRs J–N batch the MED findings by domain: M1+M2 (driver settlement state machine), M3+M9 (autopilot persistence), M4+M10+M11 (solver DTOs), etc. Each follows the same 4-reviewer pattern. Sized S each.

---

## Architectural observations carried forward

1. **Trust-boundary drift between DEX integrations.** KyberSwap + Velora have explicit `ALLOWLIST` constants with rich threat-model comments. OKX (newer integration) lacks them. The `solvers/src/infra/dex/` family needs a shared `RouterAllowlist` trait + helper so every new DEX integration *must* opt in. Future integrations (1inch, 0x, paraswap per roadmap 5.4) will repeat the OKX mistake without this.

2. **Partner-fee surface is half-CIP-75-aware.** The `MAX_BPS = 10_000` constant and `accumulated` compounding logic clearly came from CIP-75 thinking, but only the volume cap path enforces a ceiling. Surplus/PriceImprovement `factor` paths trust app_data verbatim. A single-line clamp + a recipient registry close the gap.

3. **Driver settlement state machine has grown unauditable.** Findings M1, M2, H1, H2 all stem from the `SubmitterPool`/`SettleTaskHandle`/`settlements` triad having at least three race-sensitive interactions and no central invariant statement. A state-diagram doc in `driver/src/domain/competition/mod.rs` is overdue.

4. **Health probes are aspirational, not real.** Both autopilot liveness (H3) and driver healthz (H4) report green during full subsystem failure. This is the single highest-leverage operational fix because it makes every other monitoring signal trustworthy.

5. **The `_ = ` discard pattern is endemic in error paths.** Findings H2, M14, L7, L8 all show `let _ = ...` swallowing critical errors. A clippy lint (`#![deny(clippy::let_underscore_must_use)]`) + targeted exceptions would prevent the next instance.

---

## Confidence calibration

- **C1–C4** are HIGH confidence — independent reviewers found the same surface from different angles. These should fix-first.
- **H1–H5** are unique to silent-failure-hunter but the reviewer's location citations are precise and the issues are easy to confirm by file:line reading. Recommend a fast manual cross-check before PR; do not run full `fp-check` workflow.
- **MED/LOW** tiers are single-reviewer with varying confidence; recommend `fp-check` on M5 (PK config), M6 (baseline poisoning), M7 (access-list fail-open), and Codex F1 (general Custom-interaction drain) before PR drafting since these touch security-critical paths.

---

## Out-of-band observations

- **Codex Cyber marked autopilot + solvers as "clean pass"** — this is wrong per the other 3 reviewers, who found 13 issues in those crates. Codex skimmed those modules; treat its clean-pass declarations as "did not find anything within attention budget" rather than "verified clean."
- **No reviewer found a path for the malicious-solver attacker to drain the partner-fee Safe directly.** The Safe is paid via in-batch token transfers verified by the settlement contract's flow conservation. The Safe is drainable only via C1+C3 (partner-fee griefer), not via solver-level exploits.
- **Submitter-EOA compromise threat is bounded.** Settlement holds no standing ERC-20 approvals as the submitter EOA — the EOA's only at-risk asset is its own ETH/native balance + nonce, not user funds. Tier 2 KMS (roadmap 1.9 / 6.4) primarily defends gas-loss + nonce-pollution, not direct user-fund theft.
- **Hook gas cap (PR #75) was correctly verified in scope.** No re-audit of that surface needed; the `MEDIUM-8` filter at `driver/src/domain/competition/mod.rs:700-726` does what it says.

---

## Next session checklist

1. Cross-check H1–H5 file:line citations against current `main`.
2. Run `fp-check` on M5, M6, M7, and Codex F1.
3. Confirm with Clement: initial partner-fee recipient allowlist contents (for C3 PR B).
4. Start Sprint 1 PRs (A, B, C) — CIP-75 enforcement is the highest-leverage fix and ships as a 3-PR chain through the same 4-reviewer workflow.
5. Surplus-token TODO cluster (3 sites) gets its own ticket.

---

*Generated 2026-05-18 by 4-reviewer convergence: sharp-edges-analyzer · silent-failure-hunter · differential-review:adversarial-modeler · Codex Cyber (gpt-5.3-codex). Synthesis by Claude Opus 4.7.*
