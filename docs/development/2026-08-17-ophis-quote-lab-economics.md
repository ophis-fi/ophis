# Ophis Quote Lab break-even economics

**Date:** 2026-08-17

**Scope:** Local, read-only Ethereum scenario model

**Execution/publication:** None

## Model boundary

The `economics` command runs the expanded matrix at one canonical block and
compares a candidate Ophis source with a reference Ophis source. For every
candidate win it:

1. computes the gross output-token delta;
2. values that output with the reference source's same-block quote from one
   WETH to the output token, or 1:1 when the output is WETH;
3. rounds gross native value down;
4. divides by an explicit gas-price scenario to obtain break-even incremental
   gas, rounded down; and
5. evaluates only the incremental-gas scenarios supplied by the operator.

Gas price is never fetched or presented as live network state. Incremental gas
is never inferred from quoter gas estimates or marketing benchmarks. Both are
explicit scenario inputs, and missing same-block valuation fails closed.

This is a break-even model. Actual end-to-end execution gas still requires
locally encoded interactions and full settlement simulations, neither of
which is implemented or authorized in this milestone.

## Live scenario

Inputs:

- block: `25774384`;
- hash:
  `0xe2b78618e7c43ba9ada45484b1b0ae3044a36ef22043544c921d6bf82b373a6c`;
- candidate: fixed aggregate fixture;
- reference: V3 baseline;
- gas-price scenario: `1,000,000,000` wei, or 1 gwei;
- incremental-gas scenarios: 25,000, 50,000, and 100,000 units.

All 30 cases were comparable. The candidate had one gross win:

| Case | Venue | Gross output delta | Gross native value | Break-even extra gas |
| --- | --- | ---: | ---: | ---: |
| USDC→USDT, 1,000 USDC | V4, 1 bp | `44,896` USDT base units | `23,558,920,025,690` wei | `23,558` |

The same-block valuation was the V3 baseline's WETH→USDT quote of
`1,905,690,072` USDT base units per WETH.

| Incremental gas assumption | Net native wei | Result |
| ---: | ---: | --- |
| 25,000 | `-1,441,079,974,310` | Negative |
| 50,000 | `-26,441,079,974,310` | Negative |
| 100,000 | `-76,441,079,974,310` | Negative |

Even at the deliberately low 1 gwei scenario, the smallest tested incremental
gas exceeds the observed break-even threshold.

## Historical wins at the same 1 gwei scenario

The three wins recorded at block `25774279` also have narrow gas margins:

| Case | Venue | Break-even extra gas |
| --- | --- | ---: |
| USDC→WETH, 100 USDC | V2, 30 bps | `1,472` |
| DAI→WETH, 1,000 DAI | V2, 30 bps | `61,741` |
| USDC→USDT, 1,000 USDC | V4, 1 bp | `12,649` |

The historical USDT conversion uses the same-block V3 WETH→USDT output of
`1,904,431,646` base units per WETH. At 1 gwei, only the DAI→WETH observation
survives the 25,000 and 50,000 incremental-gas scenarios; it is negative at
100,000. The other two are negative even at 25,000.

These are still scenario results. They do not prove actual route gas, and they
do not include solver operational cost or failure risk.

## Validation

- `cargo test -p ophis-quote-lab`: 14 passed
- `cargo clippy -p ophis-quote-lab --all-targets -- -D warnings`: passed;
  only two pre-existing invalid-path warnings from the workspace Clippy config
- arithmetic is integer-only with checked multiplication
- zero gas price, duplicate/zero scenarios, missing sources, missing
  valuations, and same-source comparisons are rejected

## Decision

Decision Gate 1 remains closed. The observed gross improvements are too narrow
to justify execution work without measured end-to-end gas and a longer,
multi-provider time window. No execution adapter, push, pull request,
deployment, or release is authorized.
