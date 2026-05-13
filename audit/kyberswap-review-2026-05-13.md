# KyberSwap Solver — Security/Correctness Review

**Branch:** `feat/kyberswap-solver` (commits `efde2cb31`, `4b7e57755`)
**Base:** `docs/spec-2-spec-3`
**Reviewer:** Claude Opus 4.7 + Codex (gpt-5.2)
**Date:** 2026-05-13
**Scope:** new kyberswap module + wiring, ~1,218 LoC

---

## 1. Verdict

**APPROVE_WITH_CONDITIONS**

The implementation is faithful to the plan in shape and behavior. Codex flagged one item as CRITICAL; after cross-checking against `domain/solution.rs`, the on-chain CoW settlement contract caps transfers at `order.sell.amount`, so the worst case is a failed settlement, not unbounded fund loss. The OKX module exhibits the same pattern (uses `from_token_amount` from the API response without equality check). However, several MEDIUM findings should be addressed before merging into `docs/spec-2-spec-3`, especially:

1. Add an equality guard `build.amount_in == order.amount.get()` to prevent the over-approve / failed-settlement scenario and to match OKX-style implicit-trust assumptions but with a fast-fail.
2. Replace the `RouteSummary` echo-by-struct with raw JSON to make the round-trip provably lossless (handles `null` fields and unknown keys correctly).
3. Audit the `BuildFailed → NotFound` deviation from the plan — keep it, but log it loudly so operators notice silent upstream drift.

---

## 2. Codex's findings (verbatim, severity-tagged)

### CRITICAL — Upstream-controlled `build.amount_in` can over-approve and desynchronize the signed trade from the executed calldata

> `apps/backend/crates/solvers/src/infra/dex/kyberswap/mod.rs:134` uses `build.amount_in` for both `swap.input` and allowance amount, with no check that it equals the requested sell amount from `order.amount.get()`. Then `solution.rs:154` caps the recorded executed sell amount to `order.sell.amount`, but the interaction calldata and approval still target the larger `build.amount_in`.
>
> If `/route/build` returns `amountIn > order.sell.amount` because of an upstream bug or compromise, the solver can emit a settlement that claims to fill only the signed order amount while approving and calling a router that attempts to pull more. If the settlement contract holds extra balance/buffers of the same token, this becomes an unsafe-funds path.

### MEDIUM — `RouteSummary` is not round-tripped losslessly, despite `/route/build` re-validating it

> `dto.rs:67-100` mutates the echoed `routeSummary` in several cases:
> - `amount_in_usd`, `amount_out_usd`, `gas`, `gas_price`, `gas_usd` use `#[serde(default)]` and will serialize invented empty strings when upstream omitted the field.
> - `route_id`, `checksum`, `timestamp`, `extra_fee` use `skip_serializing_if = "Option::is_none"`, so explicit upstream `null` is dropped on re-serialization.
> - `routeID: null` becomes omitted, not echoed as `null`.
>
> That is not a lossless echo. Since Kyber re-checks `routeSummary` and historically uses `checksum`/route identity fields for route binding, this can break builds or make route binding fragile.

### MEDIUM — Malformed "success" responses are downgraded to `NotFound`, hiding upstream drift

> `kyberswap/mod.rs:223` turns `code == 0 && data == null` into `Error::BuildFailed`, but `infra/dex/mod.rs:126` maps `BuildFailed` to `dex::Error::NotFound`. A semantically broken `/route/build` success response is treated downstream as "no quote", not as an upstream/API-contract failure.

### LOW — Slippage is silently clamped to 20% instead of failing fast

> `kyberswap/mod.rs:188-198` clamps any configured slippage above 2000 bps and only logs a warning. That changes solver semantics without surfacing an error to callers.

### LOW — Coverage misses the riskiest Kyber-specific edge cases

> Tests do not cover: HTTP/API 429 handling, router mismatch between `/routes` and `/route/build`, malformed JSON / missing fields, network failure between step 1 and step 2, slippage-clamp path, `routeSummary` echo fidelity.
>
> Largest gap: `market_order.rs:60-70` excludes the entire `routeSummary` from the POST-body assertion, so the most Kyber-specific invariant is effectively untested.

### Plan-vs-code deviations called out by codex

- `From<kyberswap::Error>` maps `BuildFailed` to `NotFound` (plan: `_ => Other`).
- `chain_slug()` panics on unsupported chains (plan listed Gnosis as supported; impl drops it — which is correct per KyberSwap reality).
- `market_order::sell` test excludes the entire `routeSummary` from the POST assertion (plan asked to exclude only `routeSummary.timestamp` and `routeSummary.checksum`).
- `api_calls.rs` adds an OP Sepolia smoke test stub the plan only sketched.
- `cargo check`, `cargo test`, `cargo clippy`, and binary smoke test are NOT verifiable from the tree (the agent has not run them).

---

## 3. Agent judgment on each finding

### F1 — Codex's CRITICAL on `build.amount_in` → my reclassification: **HIGH**, not CRITICAL

**Real?** Yes, the pattern exists. But the actual blast radius is bounded:

- The CoW settlement contract enforces `transferFrom(user, settlement, sell_amount) <= order.sell.amount` on-chain. The user-signed limit is binding regardless of solver bugs (`domain/solution.rs:156-158` explicit comment).
- If `build.amount_in > order.sell.amount`, the router's `transferFrom(settlement, ...)` will attempt to pull `build.amount_in` from the **settlement contract**, not from the user. Two sub-cases:
  - **Normal case:** settlement contract holds no spare balance of `sell_token` → revert → wasted gas, no fund loss.
  - **Worst case:** settlement contract holds buffer balance of `sell_token` (trusted tokens, internal balances) → the over-pull could siphon protocol buffers. This is the actual security concern.
- The OKX module (`infra/dex/okx/mod.rs:198`) has the **same pattern** — uses `from_token_amount` from the API without an equality check. So this is a pre-existing risk class, not a regression introduced by KyberSwap.

**Should fix?** Yes — add an explicit check `build.amount_in <= order.amount.get()` (or strict equality) before constructing the `Swap`. Cheap, defensive, and closes the buffer-siphon attack vector that depends on a compromised aggregator response. Worth raising as a separate hardening PR for OKX too.

**Severity:** HIGH (not CRITICAL) — fund loss is conditional on (a) compromised KyberSwap response AND (b) settlement contract holding spare balance of the over-sold token. Both conditions are non-trivial.

### F2 — RouteSummary round-trip losslessness → **MEDIUM, real**

**Real?** Yes. Specifically:
- `routeID`, `checksum`, `timestamp`, `extra_fee` are `Option<T>` with `skip_serializing_if = Option::is_none`. If upstream sends `"routeID": null`, serde deserializes to `None`, and re-serialization omits the key entirely. KyberSwap's `/route/build` may reject this as schema drift (depends on their server's strictness).
- `amount_in_usd`, `amount_out_usd`, `gas`, `gas_price`, `gas_usd` use `#[serde(default)]` returning empty strings if absent. If upstream omits them, we'll echo `""` which KyberSwap may also reject.
- The `#[serde(flatten)] extra` field DOES capture unknown fields, so net-new KyberSwap response keys round-trip cleanly. That part is good.
- **Critical edge case to investigate:** Does `#[serde(flatten)]` collide with the explicit `#[serde(rename = "routeID")]`? In theory, if upstream sends BOTH `routeID` and `routeId`, the rename-flatten interaction could behave unexpectedly. The implementation's design (rename "routeID" + flatten remainder) is correct in serde semantics — serde processes named fields first, then puts the rest into flatten.

**Should fix?** Cleaner solution is to keep the parsed `RouteSummary` for our own validation (token_in, amount_in, token_out, amount_out) but **store the original JSON `Value` separately** and echo that verbatim to `/route/build`. This is what codex recommends — preserve the routeSummary as raw JSON for echoing, parse separately for invariant checks. The current code might work in practice (KyberSwap's server is presumably lax), but a single upstream behavior change could break the entire integration silently.

**Severity:** MEDIUM. Not a security issue, but a fragility risk. Operational debugging would be hard if `/route/build` starts returning `4002 malformed body` for reasons we can't reproduce locally.

### F3 — `BuildFailed → NotFound` mapping → **LOW, plan deviation**

**Real?** Yes, this deviates from the plan, which left `BuildFailed` in `_ => Other`. The implementer's choice is operationally defensible (treat "step-2 returned null data" as a transient retry-next-cycle issue rather than a hard error) but loses observability — a real upstream contract change will look identical to a stale route.

**Should fix?** Two options:
- (a) Keep the current `NotFound` mapping but add a `tracing::warn!` inside `Error::BuildFailed` construction so the deviation is visible in logs/metrics.
- (b) Revert to the plan and map `BuildFailed → Other`. Downside: the auction loop may treat the order as solver-broken and skip the solver entirely for the rest of the cycle (depends on how `Other` propagates).

I'd take option (a) — log loudly, keep the resilient default.

**Severity:** LOW. Operational hygiene, not security.

### F4 — Silent slippage clamp → **LOW**

**Real?** Yes, but minor. The clamp is documented in the plan and the implementation logs a warn when triggered. The only failure mode codex describes is: if a solver config requests >20% slippage and that's the actual price-impact, KyberSwap will build a route assuming 20% tolerance, the actual fill exceeds 20%, the on-chain swap reverts. This is a *settlement failure*, not a fund loss. The settlement contract's pricing checks (limit price) catch this anyway.

**Should fix?** Optional. Either:
- Warn-on-clamp is already in place (`kyberswap/mod.rs:190-194`); good enough.
- Promote to an `Error::InvalidSlippage` if you want strict config-validation.

**Severity:** LOW. The plan explicitly chose clamp-with-warn.

### F5 — Test coverage gaps → **MEDIUM**

**Real?** Yes, real coverage gaps:
- No 429 / rate-limit test → the `Error::RateLimited` path is untested.
- No router-mismatch test → the equality check in `mod.rs:111-120` is dead code as far as tests can prove.
- No slippage-clamp test.
- No malformed-response test (the `BuildFailed` → `NotFound` path is exercised by `build_fails_after_route` only via `code: 4008`, not via `code: 0 + data: null`).
- The `market_order::sell` test excludes the entire `routeSummary` from the POST body assertion (`vec!["routeSummary", "deadline"]`) — so the most KyberSwap-specific invariant (echo correctness) is not tested. The plan said to exclude only `routeSummary.timestamp` and `routeSummary.checksum`.

**Should fix?** Yes — at minimum:
- Tighten `market_order::sell`'s `RequestBody::Partial` to exclude only `routeSummary.timestamp` and `routeSummary.checksum` (per plan), so the test catches routeSummary serialization regressions.
- Add a `not_found::build_returns_null_data` test for the `code: 0 + data: null` path.
- Add a `mismatched_router_address` test that asserts the equality check at `mod.rs:111` actually fires.

**Severity:** MEDIUM for the routeSummary echo test gap. LOW for the others.

### F6 — Chain slug coverage → **INFO**

The implementation's `chain_slug()` panics on `Gnosis`, `Goerli`, `Plasma`, `Ink` (codex flagged Gnosis specifically). The plan listed Gnosis in the slug map but the implementer dropped it. The KyberSwap docs at the time of writing confirm KyberSwap does not deploy on Gnosis, so this is **correct** — the implementer caught a plan mistake. No action.

### Items where I disagree with or weaken codex's analysis

- Codex's "CRITICAL" on `build.amount_in` is overstated. The CoW settlement contract enforces the user-signed limit on-chain (`solution.rs:156-158`). Worst case is a failed settlement, not a fund drain — unless the settlement contract holds buffer balances of the over-sold token, which is a conditional risk. The OKX module exhibits the same pattern, so this isn't a new vulnerability class. Reclassified to HIGH.
- Codex calls `BuildFailed → NotFound` "more dangerous than the plan's `_ => Other`". Disagree — `NotFound` is the operationally safer default (auction-loop retries cleanly). The danger is observability, not safety. Reclassified to LOW.

### Items codex missed

- **Calldata sanitization**: `BuildData.data: Vec<u8>` is taken verbatim from the API and used as the call target's calldata. There's no sanity check (e.g. the calldata's encoded function selector matches a known KyberSwap router selector). This is consistent with OKX (same pattern), so not a regression — but worth noting as an existing trust assumption.
- **`x-client-id` is shared, not unique**: Default `"ophis-solver"` (mod.rs:29) is hardcoded. If multiple Ophis deployments run this code, they all share one rate-limit bucket. Operators should be encouraged in the example config to override with a unique value. The example.kyberswap.toml already mentions this — fine.
- **Optimism Sepolia chain ID not in `ChainId` enum**: the `api_calls::swap_sell_live_op_sepolia` test bypasses `chain_slug()` by setting `base_url` explicitly and reusing `ChainId::Optimism` "as a placeholder". This is brittle — anyone enabling Sepolia in production via TOML would either hit the panic or get incorrect logging. Plan note in section 8 acknowledged this. Acceptable for now (test-only), but worth a TODO.

---

## 4. Recommended actions before merging `feat/kyberswap-solver` into `docs/spec-2-spec-3`

### Must-fix (block merge)

1. **Add `build.amount_in` guard** in `kyberswap/mod.rs:134` — reject (or clamp to `order.amount.get()`) if `build.amount_in != order.amount.get()`. Closes the buffer-siphon attack path conditional on aggregator compromise.

   ```rust
   if build.amount_in != order.amount.get() {
       return Err(Error::Api {
           code: -1,
           reason: format!(
               "/route/build returned amount_in {:?}, expected {:?}",
               build.amount_in, order.amount.get()
           ),
       });
   }
   ```

2. **Tighten `market_order::sell` test** at `tests/kyberswap/market_order.rs:60` — change `vec!["routeSummary", "deadline"]` to `vec!["routeSummary.timestamp", "routeSummary.checksum", "deadline"]` per the plan. This exercises the routeSummary round-trip serialization on every test run.

### Should-fix (high-priority follow-up, can merge if explicitly deferred)

3. **Add `routeSummary`-echo-fidelity tests** that verify upstream `null` fields round-trip correctly (or document the limitation if KyberSwap accepts both forms). Alternatively, refactor `RouteSummary` to store raw JSON for echoing.

4. **Add a router-address-mismatch test** to prove the check at `mod.rs:111-120` works.

5. **Add a 429 / rate-limit test** to prove the `Error::RateLimited` path is reachable through both `RoundtripError::Http(Status(429))` and `RoundtripError::Api(code: 429 | 4429)`.

6. **Add a `code: 0 + data: null` test** for `/route/build` to exercise the `Error::BuildFailed` → `Error::NotFound` mapping deliberately.

### Nice-to-have (post-merge)

7. **Log at WARN-level when `BuildFailed → NotFound` mapping fires** so operators see upstream drift in metrics. Currently silently dropped.

8. **Cross-reference the OKX module** — the same `build.amount_in` trust pattern exists at `okx/mod.rs:212` (`from_token_amount` used verbatim). If hardened in KyberSwap, harden in OKX too (separate PR).

9. **Document the calldata-trust assumption** in the module docstring — we trust KyberSwap's calldata to encode only ERC-20 swaps on the returned router. Future work could selector-check the first 4 bytes against the known MetaAggregationRouterV2 ABI.

### Verification before merging

- [ ] `cargo check -p solvers` clean (the agent has NOT verified this — the worktree exists but cargo was not run).
- [ ] `cargo test -p solvers kyberswap` — all 6 unit tests pass.
- [ ] `cargo test -p solvers` — no regressions in OKX/Bitget tests.
- [ ] `cargo clippy -p solvers -- -D warnings` — clean (`AtomicU64` is used; no dead imports observed in dto.rs/mod.rs).
- [ ] Optionally: run `swap_sell_live_op_mainnet` against live KyberSwap to confirm routeSummary echo works on real responses.

---

## Files reviewed

- /Users/scep/greg/docs/spec-2-spec-3/kyberswap-solver-plan.md
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/infra/dex/kyberswap/mod.rs (305 lines)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/infra/dex/kyberswap/dto.rs (166 lines)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/infra/config/dex/kyberswap/{mod,file}.rs
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/config/example.kyberswap.toml
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/tests/kyberswap/*.rs (5 files)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/infra/dex/mod.rs (wiring diff)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/infra/cli.rs (wiring diff)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/run.rs (wiring diff)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/infra/dex/okx/mod.rs (comparison)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/domain/{dex,solution}.rs (for understanding Swap semantics)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/util/http.rs (for `roundtrip!`)
- /tmp/greg-kyberswap-review/apps/backend/crates/solvers/src/tests/mock/http.rs (for `RequestBody::Partial`)

## Worktree (review artifact, can be cleaned up)

- `/tmp/greg-kyberswap-review` — git worktree for `feat/kyberswap-solver`. Remove with `git worktree remove /tmp/greg-kyberswap-review` after the patches land.
