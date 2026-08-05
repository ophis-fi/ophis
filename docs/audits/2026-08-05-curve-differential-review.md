# Curve Direct Solver Differential Security Review

## Executive Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

**Overall risk:** Medium, because this change adds an on-chain value-transfer
target and a driver authorization exception.  
**Recommendation:** Approved by independent Codex review; merge only after CI.

The reviewed scope adds an exact-input-only direct Curve solver for Optimism's
canonical 3pool. The production pool and ordered coin list are compile-time
allowlisted, authenticated onchain at startup, quoted onchain, and executed with
an onchain `min_dy`. The driver accepts only the exact `exchange(int128,int128,
uint256,uint256)` shape and binds indices, assets, amounts, allowance, chain,
target and non-internalization to the declared solution.

## What Changed

**Baseline:** `origin/main` at `28ad101e`  
**Branch:** `codex/green-protocols`

The change touches twelve production/configuration files plus this report:

- New Curve solver, configuration loader and example configuration.
- Solver CLI, dispatch and metrics wiring.
- Selector-scoped driver authorization for the Optimism 3pool.
- Optimism solver service, driver registration and rendered configuration.

## Security-Critical Flows

### Quote and execution

`Curve::swap` at `apps/backend/crates/solvers/src/infra/dex/curve/mod.rs:112`
rejects BUY orders, resolves only a compile-time-approved token pair, reads
`get_dy` directly from the pool, applies bounded slippage, and encodes the same
indices/input/floor into `exchange`.

### Configuration authentication

`Curve::try_new` at `curve/mod.rs:54` rejects empty, duplicate, zero or
non-allowlisted pool/coin configurations. `validate_onchain` at line 90 compares
every configured coin index with the live contract and fails startup on RPC or
mismatch.

### Driver authorization

`validate_curve_exchange` at
`apps/backend/crates/driver/src/domain/competition/solution/custom_allowlist.rs:495`
requires:

- chain 10 and the canonical 3pool target;
- the exact four-word exchange selector and zero native value;
- distinct in-range pool indices;
- one input, one output and one exact-amount allowance;
- calldata/input/output/allowance token and amount agreement;
- an output floor no lower than the driver-required output;
- routed input no greater than the fulfillment input; and
- `internalize == false`.

The DTO boundary derives the validation context only for exactly one protected
direct-liquidity interaction and exactly one SELL fulfillment. It authenticates
both order tokens, the fulfillment input cap, and the clearing-price output
floor before the interaction reaches the allowlist.

The pool is deliberately absent from the generic target allowlist, so it cannot
be used through raw pre/post interactions.

## Adversarial Analysis

**Attacker model:** a compromised solver capable of returning arbitrary Custom
interactions to the driver.

Attempted attack classes:

1. Replace `exchange` with an arbitrary selector: rejected by exact selector and
   calldata-length checks.
2. Redirect the allowance: rejected by exact spender/token/amount binding.
3. Change pool indices while claiming different assets: rejected by the
   compile-time index-to-token mapping and declared input/output checks.
4. Consume more sell token than fulfillment supplies: rejected by the
   `amount_in <= required_input` bound and exact declared-input/allowance match.
5. Lower the execution floor below credited output: rejected by
   `min_out >= required_output`.
6. Skip execution through internalization: rejected explicitly.
7. Reach the pool through pre/post calls: rejected because the pool is not in
   the generic target allowlist.

No exploitable bypass was found in the reviewed flow.

## Tests and Runtime Evidence

- `cargo test -p solvers curve --lib`: 2 passed.
- `cargo test -p driver custom_allowlist --lib`: 28 passed.
- `cargo test -p solvers --lib`: 176 passed, 12 ignored.
- `cargo test -p driver --lib`: 135 passed, 84 ignored.
- `docker compose ... config --no-interpolate`: passed.
- `bash -n infra/optimism-mainnet/compose-up.sh`: passed; `curve-solver` is in
  both config-bound restart arrays.
- Solver startup against Optimism RPC: passed, including live coin-index
  authentication.
- Optimism fork execution from Ophis Settlement: 1 DAI quoted 999,424 USDC.e
  atoms; floor 989,429; Settlement received 999,424.
- `git diff --check`: passed.

The driver tests mutate selector, output token, spender, internalization, input
upper bound and output floor, and confirm chain and raw-target isolation.

## Blast Radius

- New `Dex::Curve` dispatch: one caller in the shared DEX solver path.
- New driver exception: one branch inside the existing Custom validation choke
  point, whose callers already require `required_amounts` for executable
  solutions.
- Production impact is limited to the new Optimism `curve-solver` service and
  three configured stablecoins.

## Sharp-Edges Review

The original configurable-pool design was an operational footgun: an operator
could configure a pool that the driver would later reject. It was tightened so
only the compile-time-approved pool and exact ordered coins can start. BUY mode
is unavailable rather than emulated with an unsafe exact-input approximation.
Internalization is disabled both in loader code and production configuration.
The solve path uses the shared fee-aware bounded-slippage calculation, while
the quote path continues to report the configured onchain floor.

## Independent Codex Findings

The first Codex 5.6 Sol pass rejected the change for four issues: an fxUSD-only
DTO context that made Curve unexecutable, missing sell-token authentication,
fixed slippage on tight/partial limit orders, and omission from config-mounted
restart arrays. All four were corrected before the final re-review. The driver
now authenticates both fulfillment assets and protected-interaction
cardinality; Curve uses fee-aware bounded slippage; and deployment restarts the
solver after rendered config changes.
The second pass approved the corrected diff with no material findings.

## Tooling Limitations

- CodeQL does not support Rust, so it cannot analyze the security-critical
  implementation. No claim of CodeQL coverage is made.
- Repository-wide rustfmt currently reports broad pre-existing formatting drift
  caused by stable rustfmt ignoring the repository's nightly-only options.
- Workspace clippy with `-D warnings` is blocked by pre-existing warnings in
  unrelated files. Compilation and focused tests for both changed crates pass.
- No dependency versions changed, so Dependabot has no new dependency delta to
  assess in this change.

## Recommendation

Before production:

- [x] Close all independent Codex review findings.
- [ ] Run repository CI on the final commit.
- [ ] Deploy only to Optimism; do not claim Ethereum support.
- [ ] Run one production canary order before enabling unrestricted traffic.

## Methodology

The review used a surgical HIGH-risk differential analysis: baseline invariant
reconstruction, call-site and blast-radius tracing, line-by-line external-call
analysis, configuration misuse analysis, adversarial Custom-interaction
mutation, canonical-source address comparison, live bytecode/quote checks and a
forked execution proof. All security-critical changed code and its immediate
callers were reviewed. Confidence is high for the scoped Optimism 3pool lane.
