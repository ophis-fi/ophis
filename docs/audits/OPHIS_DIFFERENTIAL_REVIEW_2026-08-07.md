# Ophis Ekubo + UP33 Differential Security Review

## Executive Summary

| Severity | Open | Resolved during review |
|---|---:|---:|
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 0 | 1 |
| Low | 0 | 0 |

**Overall risk:** Medium before review hardening; Low after remediation.

**Recommendation:** APPROVE for push. Production deployment remains subject to the normal Robinhood render, startup-health, and live-canary checks.

**Key metrics:**

- Files analyzed: 21/21 changed files (100%)
- High-risk files deeply analyzed: 4/4 (solver execution and driver validation)
- Security regressions detected: 0
- Open test gaps blocking push: 0
- External trust boundaries: Ekubo HTTPS quoter; Robinhood RPC; four pinned protocol contracts

## What Changed

**Commit range:** `f8d152c34c^..f8d152c34c`, plus review remediation in the working tree.

**Change size:** 1,212 additions and 3 deletions in the original commit across 21 files.

| Area | Risk | Change |
|---|---|---|
| Ekubo solver | High | Validates hostile quote JSON, encodes bounded packed routes, pins Router and Ve33 |
| UP33 solver | High | Discovers Solidly pools onchain and encodes bounded exact-input paths |
| Driver custom validation | High | Independently binds targets, calldata, assets, amounts, allowance, recipient and route grammar |
| Protected-lane isolation | High | Extends the existing one-trade/one-interaction/no-pre-or-post-call invariant |
| Robinhood infra | Medium | Registers, activates, configures and health-gates both solver lanes |

The baseline direct-liquidity invariant introduced in commits `eb32a1683f` and `d67dc2cf2d` remains intact: protected lanes may submit exactly one trade and one ordinary interaction, with no solver-supplied pre/post interactions. No existing validation was removed.

## Findings

### Resolved — Medium: Ekubo route control word was not independently constrained

**Files:** `apps/backend/crates/solvers/src/infra/dex/ekubo.rs`; `apps/backend/crates/driver/src/domain/competition/solution/custom_allowlist.rs`

**Attacker model:** Compromised or malicious Ekubo quoter, or compromised solver process.

**Entry point:** The quoter-provided `skip_ahead` field encoded into each packed Router hop.

The driver validated a simple, connected sequence of token pairs but originally skipped over the final four-byte Ekubo route control word. A non-zero control can change route execution semantics, so the execution interpreted by the Router could differ from the linear path independently reconstructed by the driver.

**Remediation:** The solver now rejects every non-zero control before encoding, and the driver independently requires all four control bytes to be zero for every hop. A solver test and a driver rejection test cover both sides. The Ekubo HTTP client also has a four-second timeout to bound upstream unavailability.

**Residual impact:** None in the accepted grammar. Advanced Ekubo skip/partial-fill routes are intentionally unavailable until their semantics receive a dedicated validator.

## Adversarial Analysis

The concrete attacker considered is a compromised solver or quote API attempting to make Settlement execute calldata different from the declared solution.

- An arbitrary target is rejected: both lanes are chain-4663 gated and pinned to one target.
- An arbitrary allowance is rejected: exactly one allowance must match the sell token, pinned router, exact input, and global cap.
- Asset or amount substitution is rejected: calldata and declared inputs/outputs must match the auction fulfillment bounds.
- A recipient substitution is rejected: UP33's ABI recipient and Ekubo's packed recipient must equal Robinhood Settlement.
- UP33 arbitrary router functionality is rejected: only selector `0xcac88ea9`, one or two routes, the pinned factory, and an optional WETH middle hop are accepted.
- Ekubo arbitrary forwarding is rejected: only extensionless Core or the pinned Robinhood Ve33 extension is accepted; token order, connectivity, hop/split bounds, exact length and zero controls are enforced.
- Extra solver calls are rejected by the protected-lane isolation invariant, including solver-supplied pre- and post-interactions.

No reachable fund-loss scenario remained after remediation. Invalid or stale protocol state causes quote rejection, simulation failure, or transaction revert rather than widening permissions.

## Test Coverage Analysis

Executed successfully:

- `cargo check -p solvers -p driver`
- Ekubo unit tests: 3 passed, including non-zero control rejection
- Driver custom-allowlist tests: 30 passed, including Ekubo and UP33 calldata poisoning cases
- `git diff --check`
- Robinhood shell syntax checks
- Docker Compose model validation with inert placeholder secrets

The repository-wide stable `cargo fmt --all -- --check` is not a usable gate in this worktree because the checked-in nightly rustfmt configuration produces unrelated diffs throughout generated and pre-existing files. The changed Rust files compile and their targeted tests pass.

## Blast Radius Analysis

| Function/path | Direct consumers | Blast radius | Containment |
|---|---:|---|---|
| `validate_with_required_output` | All custom interactions | High | New branches are target- and chain-specific and fail closed |
| `required_custom_amounts` | Solver DTO conversion | High | Existing protected-lane isolation reused unchanged |
| Ekubo `swap`/encoder | Ekubo lane only | Low | Pinned API, Router, Ve33; SELL-only ERC-20 scope |
| UP33 `swap`/routing | UP33 lane only | Low | Pinned factory/router; max two hops |
| Robinhood auction/quote wiring | Robinhood only | Medium | Explicit solver names and health dependencies |

## Historical Context

- `eb32a1683f` established direct-liquidity lane activation and interaction isolation.
- `d67dc2cf2d` extended isolation to solver pre/post calls following security review.
- The current change adds the two Robinhood targets to that model; it does not relax generic allowlists or remove historical security checks.

## Recommendations

### Immediate

- [x] Reject non-zero Ekubo route controls in both solver and driver.
- [x] Add regression tests for the rejected control word.
- [x] Bound Ekubo HTTP request duration.

### Before production

- [ ] Render configs through the normal RAM-backed deployment wrapper.
- [ ] Require both new containers and the driver/orderbook/autopilot to become healthy.
- [ ] Run small ERC-20 SELL canaries on each lane and verify Settlement receipts and solver metrics.

### Future scope

- Advanced Ekubo control-word routes, native/WETH wrapping, and BUY orders require separate implementation and review; they are deliberately rejected now.

## Analysis Methodology

**Strategy:** Surgical high-risk differential review in a large Rust monorepo.

Techniques applied:

- Complete changed-file review and focused baseline/history inspection
- One-hop call-site and configuration blast-radius tracing
- Attacker modeling for compromised external API and solver processes
- Packed-calldata boundary, length, connectivity and fulfillment analysis
- Fail-open/default and operational configuration review
- Targeted compilation, unit tests, syntax checks and Compose validation

**Limitations:** This review did not audit Ekubo or UP33 contract bytecode and does not claim protocol-level correctness beyond pinned-address/code-presence and live quote checks already performed. It did not execute a funded mainnet swap.

**Confidence:** High for Ophis driver containment and accepted calldata grammar; medium for upstream protocol behavior.

## Appendix: Scope

Reviewed commit: `f8d152c34c` (`Add Ekubo and UP33 Robinhood solver lanes`). Review remediation is intended to be committed on the same branch before push.
