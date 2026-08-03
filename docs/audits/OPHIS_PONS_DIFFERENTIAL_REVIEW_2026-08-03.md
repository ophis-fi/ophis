# Ophis pons Integration — Differential Security Review

## Executive Summary

| Severity | Open | Remediated |
|---|---:|---:|
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 0 | 0 |
| Low | 0 | 1 |

**Overall risk:** Low for the reviewed adapter and deployment wiring.
**Recommendation:** Conditional approval after the full CI suite and a forked settlement simulation pass. Do not deploy from this review alone.

The integration introduces a chain-specific solver that authenticates launch tokens through pinned pons factories, verifies their WETH pools through the pinned V3 factory, quotes through the pinned Quoter V2, and emits calls only to the independently allowlisted SwapRouter02. It supports exact-input and exact-output orders over one hop (`token ↔ WETH`) and two hops (`token A → WETH → token B`).

Key metrics:

- 13 changed/new files reviewed; all high-risk value-routing code reviewed line by line.
- One direct caller of `Pons::swap`; low blast radius.
- Three focused unit tests cover overflow-safe slippage, V3 path encoding, and router selectors.
- Live Quoter V2 probes covered both exact-input and reversed exact-output two-hop paths.
- No removed security checks, historical security regressions, unsafe Rust, unchecked arithmetic, or user-selected execution targets found.

## What Changed

**Baseline:** `576596dd` (working-tree differential)
**Review date:** 2026-08-03

| Area | Change | Risk | Blast radius |
|---|---|---|---|
| `infra/dex/pons` | New discovery, authentication, quoting, slippage, path encoding, and calldata | High | Low (one dispatch caller) |
| Driver custom allowlist | Chain-4663 router/spender entry and isolation test | High | Low (Robinhood custom solutions only) |
| Solver CLI/config/run | New Pons command and fail-fast construction | Medium | Low |
| Robinhood deployment | New solver service and driver registration | Medium | Robinhood stack |
| Documentation | Operator contract-pinning guidance | Low | None |

The change is additive. It removes no validation or access-control code. Git searches found no prior Pons adapter or removed security fix being reintroduced.

## Security Model and Invariants

The reviewed implementation must preserve these invariants:

1. A non-WETH asset is routable only when a pinned launch factory reports an existing record whose token and paired token match the requested token and pinned WETH.
2. Every hop resolves to a nonzero pool in the pinned V3 factory at the launch's snapshotted fee.
3. Execution always targets the pinned router; neither order data, token metadata, factory output, nor quote output can choose a target or spender.
4. The driver independently allows that router only on chain ID 4663.
5. Exact-input calldata enforces the same minimum output reported as the clearing amount.
6. Exact-output calldata enforces the same maximum input granted as allowance and reported as the input amount.
7. Exact-output multi-hop paths are reversed as required by Uniswap V3.
8. Slippage arithmetic cannot overflow and configured slippage is capped at 20% by the adapter.

The flow is:

`auction order → authenticate endpoint(s) → verify pool(s) → quote pinned quoter → apply bounded slippage → encode pinned router call → driver target/spender allowlist → settlement`

Trust assumptions are limited but material: correctness of the pinned Pons factory records, V3 factory, pools, quoter, router, Robinhood RPC state, and canonical settlement allowance/call semantics. The adapter does not assert token quality or protect against thin liquidity, price impact, MEV, or malicious ERC-20 behavior beyond the existing settlement simulation and token-handling controls.

## Findings

### Remediated — Low: zero factory entry could create confusing authentication behavior

**Location:** `apps/backend/crates/solvers/src/infra/dex/pons/mod.rs`, constructor validation
**Attacker model:** deployment/configuration mistake, not an unprivileged remote attacker
**Exploitability:** hard

The initial constructor rejected an empty factory list and zero-valued core contracts but did not reject a zero address inside a nonempty factory list. Calls to an address without code are provider/ABI dependent and could fail opaquely, turning a simple configuration defect into availability loss or inconsistent startup behavior.

**Resolution:** construction now rejects any zero entry in `factories`. This is fail-closed and covered by Rust type-safe construction; a dedicated provider-backed constructor test remains recommended.

No open Critical, High, or Medium finding was identified in the reviewed scope.

## Adversarial Analysis

### Forged launch token

An attacker submits an order containing an arbitrary ERC-20 and attempts to make the solver call the Pons router. The token fails `getLaunchedToken` across all pinned factories, so no swap is produced. A token cannot self-report its own legitimacy; token getters are not used for authentication.

### Forged or missing pool

Even if a pinned factory record exists, the adapter rejects a mismatched token, non-WETH pair, false `exists` flag, or zero pool from the pinned V3 factory. The record cannot redirect execution to an arbitrary pool or router.

### Exact-output underfunding through path direction confusion

Uniswap V3 exact-output paths use output-to-input order. The adapter explicitly encodes `buy token → buy fee → WETH → sell fee → sell token`, and a live Quoter V2 call succeeded for this direction. The router selector is pinned by a unit test to `0x09b81346`.

### Quote/execution divergence and MEV

An attacker or searcher can move pool prices after quoting. Router calldata enforces `amountOutMinimum` or `amountInMaximum`; a bad movement reverts rather than exceeding the solver's reported bound. This preserves funds but can reduce settlement availability. It is an inherent AMM/MEV risk, not eliminated by this adapter.

### Malicious RPC or compromised pinned contract

A malicious RPC can return false quote/factory state, but final settlement simulation and onchain execution still target fixed contracts and enforce limits. A compromised or incorrectly pinned router remains a full value-transfer trust boundary. Changes to any pinned address therefore require code/config review plus driver allowlist review.

## Test Coverage

| Behavior | Evidence | Status |
|---|---|---|
| Slippage floor/ceiling and `U256::MAX` overflow | Unit test | Covered |
| 3-byte big-endian two-hop path | Unit test | Covered |
| SwapRouter02 no-deadline selectors | Unit test | Covered |
| Exact-input two-hop quote | Live chain-4663 Quoter V2 probe | Covered |
| Exact-output reversed two-hop quote | Live chain-4663 Quoter V2 probe | Covered |
| Driver chain isolation | Driver unit test | Covered |
| Full settlement execution on a fork | Not run in this review | Gap |
| Token callback/nonstandard ERC-20 behavior | Existing settlement simulation only | Gap |
| Constructor zero-factory entry | Validation present; no direct unit test | Minor gap |

The main remaining pre-production gap is an end-to-end fork test that executes both sell and buy orders through GPv2 settlement, including allowance behavior and balance deltas.

## Sharp-Edge and Insecure-Default Review

- Fixed contract addresses are mandatory; unknown TOML fields are rejected.
- Empty and zero-address factory configurations fail closed.
- Interaction internalization is disabled for the external Pons call.
- The execution target and spender are not configurable per order or learned from an RPC response.
- Integer calculations widen to 512 bits and narrow with checked conversion.
- No `unsafe`, `unwrap`, unchecked blocks, magic unlimited allowance, or silent fallback to a different router exists in the adapter.
- A 20% hard maximum bounds a mistakenly high driver slippage setting; production is configured at 1%.
- Router/factory upgrades require explicit operator action. This creates maintenance overhead but avoids trusting mutable discovery.

## Pashov and Verity Applicability

The installed Pashov `x-ray` and `solidity-auditor` workflows target Solidity/Foundry/Hardhat source trees. The changed value-routing implementation is Rust and no Solidity file changed, so those scanners have no applicable source target and were not represented as having reviewed the adapter. Their threat-model themes—entry points, integrations, invariants, privileged configuration, test gaps, and git-weighted changes—were applied manually in this report.

Verity's checked Ophis artifact proves the separate `AllowListGuardian.sol` access-control model. It does not ingest or prove Rust solver logic. Its existing `Contracts` target was run as a regression check; its result must not be interpreted as a proof of Pons path encoding, quoting, or execution safety.

## Recommendations

### Before production

- [ ] Add a forked chain-4663 end-to-end test for single-hop and two-hop, sell and buy orders.
- [ ] Verify the configured router and quoter `factory()`/`WETH9()` getters at solver startup, not only operationally.
- [ ] Add alerts for Pons solver quote errors, reverts, stale RPCs, and zero-solution periods.
- [ ] Re-run full backend CI and compose rendering checks after the final diff.

### Operational

- [ ] Treat every factory/router/quoter/WETH change as a new integration version.
- [ ] Monitor Pons factory `TokenLaunched` events for coverage, but keep execution authentication onchain and pinned.
- [ ] Keep strict market-output simulation enabled in the driver.

## Methodology

**Strategy:** focused differential review with deep analysis of all high-risk paths.

Techniques applied:

- complete working-tree diff and new-file review;
- baseline call-flow and settlement allowlist tracing;
- git history/regression searches;
- trust-boundary and invariant extraction;
- attacker modeling for forged tokens/pools, RPC manipulation, MEV, path reversal, and configuration errors;
- Trail of Bits sharp-edge and insecure-default checklists;
- arithmetic/path/selector unit tests;
- live contract registry, pool, and Quoter V2 verification.

Limitations:

- This is not an independent audit of Pons, Uniswap V3, GPv2 Settlement, or Robinhood Chain.
- No production deployment or real-value transaction was performed.
- Rust line coverage was not generated.
- No formal tool currently proves the Rust-to-EVM calldata semantics.

**Confidence:** high for the reviewed adapter/control-flow scope; medium for end-to-end production behavior until fork execution tests are added.
