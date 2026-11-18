# Ophis WOOFi Differential Security Review

## Executive Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

**Overall risk:** Medium (new value-transfer integration)  
**Recommendation:** Conditional approval after independent Codex review and production simulation.

The implementation pins WOOFi's Optimism router at compile time, supports exact-input SELL orders only, uses exact per-trade allowances, and keeps the router out of the generic address allowlist. The driver accepts only the six-word `swap(address,address,uint256,uint256,address,address)` calldata shape and binds its assets, amounts, Settlement recipient, zero rebate, declared inputs/outputs, and allowance to the fulfillment context.

## What Changed

The uncommitted branch adds a direct WOOFi solver, CLI/config wiring, a selector-scoped driver validator, focused adversarial tests, and Optimism deployment configuration. No existing security validation was removed.

High-risk files reviewed in full:

- `apps/backend/crates/solvers/src/infra/dex/woofi.rs`
- `apps/backend/crates/driver/src/domain/competition/solution/custom_allowlist.rs`

Deployment/configuration files and all wiring changes were also reviewed.

## Findings

No blocking security finding remains in the reviewed diff.

Codex initially found that the DTO layer did not classify WOOFi as a protected
direct-liquidity target, which would have omitted the fulfillment context and
caused every interaction to fail closed. The protected-target list was fixed
and a DTO-level regression test now connects context generation to the focused
validator coverage.

The principal attacker model is a compromised or malicious solver attempting to make Settlement approve or call an unintended target. The driver boundary rejects arbitrary WOOFi selectors (including external-swap functionality), non-zero native value, mismatched assets or fulfillment amounts, alternate recipients, rebate recipients, extra interactions, internalization, alternate spenders, and oversized allowances.

## Test Coverage

- Driver custom-allowlist suite: 27 passed, including selector, recipient, rebate, spender, internalization, fulfillment, and allowance-cap checks.
- WOOFi unit tests: 2 passed, covering the canonical selector and overflow-safe slippage floor.
- `cargo check -p solvers -p driver`: passed.
- `cargo audit --no-fetch`: no vulnerabilities; two pre-existing allowed yanked-crate warnings.
- Compose interpolation-independent validation and shell syntax checks: passed.
- Live Optimism router bytecode and WETH-to-USDC `querySwap`: passed.

Remaining production gate: simulate a complete solver-produced settlement against the latest Optimism block before deployment.

## Blast Radius

`validate_with_required_output` is a shared driver trust boundary. The new branch is limited to chain ID 10 and the single pinned WOOFi target, so existing targets and chains continue through their previous paths. The new solver is reachable only through the new `woofi` command and deployment service.

## Sharp-Edge Analysis

- Router address cannot be configured to an arbitrary contract: constructor rejects anything except the compile-time Optimism address.
- Interaction internalization is forced off in config loading.
- Slippage is capped at 2,000 bps and uses overflow-safe arithmetic.
- Zero addresses, zero amounts, BUY orders, and same-token swaps fail closed.
- RPC execution reverts are categorized as unavailable liquidity, enabling partial-fill reduction; transport failures remain operational errors.
- Secret-bearing RPC configuration is rendered to the managed RAM disk.

## Methodology and Limitations

Strategy: surgical review of a high-risk external-call/value-transfer change in a large Rust codebase. The review compared existing Curve/f(x) validation patterns, traced the solver-to-driver interaction shape, inspected one-hop callers, tested concrete malicious calldata variants, checked deployment scripts, and queried the live Optimism contract.

The review does not audit WOOFi's protocol contracts or eliminate protocol upgrade/admin risk. Confidence is high for Ophis-side target/calldata confinement and medium for end-to-end production behavior until full settlement simulation completes.
