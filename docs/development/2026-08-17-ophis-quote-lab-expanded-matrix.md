# Ophis Quote Lab expanded Ethereum matrix

**Date:** 2026-08-17

**Scope:** Local, read-only shadow measurement

**Execution/publication:** None

## Matrix

The expanded matrix contains 30 exact-input cases over standard Ethereum contracts:

- WETH/USDC and WETH/DAI controls from the initial matrix;
- WETH/USDT;
- USDC/USDT;
- WETH/WBTC;
- WETH/wstETH;
- WETH/rETH.

Every pair is measured in both directions. Each run uses one canonical EIP-1898 block hash for all four Ophis sources, with no retry or source substitution.

## Provider A

- Block: `25774279`
- Hash: `0x6003f6948e82ad8ea6d0d90fc25ff8662aa3b0628b61fc9328cd8f172d5164e0`

| Ophis source    | Success | Winning cases | Outright wins |        p50 |        p95 |
| --------------- | ------: | ------------: | ------------: | ---------: | ---------: |
| Fixed fixture   |   30/30 |            30 |             0 |  42.647 ms | 260.968 ms |
| Prior fixture   |   30/30 |            30 |             0 |  40.133 ms | 258.268 ms |
| Current fixture |   20/30 |            20 |             0 |  38.953 ms | 360.323 ms |
| V3 baseline     |   30/30 |            27 |             0 | 142.829 ms | 228.445 ms |

The fixed and prior fixtures returned identical best outputs in all 30 cases. The current fixture returned the same best output when it succeeded, but reverted in every case involving USDC: 10 failures total.

The aggregate fixtures beat the V3 baseline in three cases:

| Case                  | Winning venue | Gross improvement |                  Output delta |
| --------------------- | ------------- | ----------------: | ----------------------------: |
| USDC→WETH, 100 USDC   | V2, 30 bps    |       0.28034 bps |  `1,472,769,631,556` wei WETH |
| DAI→WETH, 1,000 DAI   | V2, 30 bps    |       1.17557 bps | `61,741,785,933,131` wei WETH |
| USDC→USDT, 1,000 USDC | V4, 1 bp      |       0.24071 bps |      `24,091` USDT base units |

These are gross quote improvements. They do not include venue execution gas, settlement overhead, solver costs, or failure risk. The current harness therefore cannot classify them as positive net surplus.

In the other 27 cases the V3 baseline tied the aggregate fixtures exactly.

## Provider B

- Block: `25774282`
- Hash: `0x446694b7af570c217806c77c30983eb7080aa2f38ed4c0679af9e56280b7c326`

| Ophis source    | Success | Winning cases | Outright wins |        p50 |        p95 |
| --------------- | ------: | ------------: | ------------: | ---------: | ---------: |
| Fixed fixture   |   29/30 |            29 |             0 |  68.098 ms | 190.882 ms |
| Prior fixture   |   29/30 |            29 |             0 |  63.329 ms | 147.872 ms |
| Current fixture |   19/30 |            19 |             0 |  59.067 ms | 139.649 ms |
| V3 baseline     |   30/30 |            28 |             1 | 210.713 ms | 305.096 ms |

The provider rejected the fixed and prior aggregate calls for WETH→USDC at 10 WETH because the required call gas exceeded its 50,000,000 cap. The baseline's apparent outright win was an availability result, not a better price. The current fixture repeated its 10 USDC-related reverts and also recorded one unretried HTTP transport failure.

## Interpretation

The expanded sample changes the initial conclusion only slightly:

1. Aggregate venue selection can improve gross output, but it did so in only 3 of 30 cases and by 0.24–1.18 bps.
2. The fixed and prior fixtures are functionally identical in every observed successful case.
3. The current fixture's USDC-specific failure remains deterministic across providers and blocks.
4. Heavy aggregate calls are sensitive to provider gas caps; availability must be benchmarked per production RPC policy.
5. Sequential latency is not an apples-to-apples computational comparison: the V3 baseline performs four separate calls.

Decision Gate 1 remains closed. Before any execution design, Ophis still needs repeated time-window samples, direct V2 and V4 controls, and an end-to-end gas model that converts gross output deltas into net surplus.

The direct V2 control was subsequently completed and reproduced both
V2-labelled wins at the original block. Its implementation and evidence are
recorded in
[`2026-08-17-ophis-quote-lab-v2-baseline.md`](./2026-08-17-ophis-quote-lab-v2-baseline.md).

The direct hookless V4 control was also completed and reproduced the
V4-labelled win at the original block. Its implementation and evidence are
recorded in
[`2026-08-17-ophis-quote-lab-v4-baseline.md`](./2026-08-17-ophis-quote-lab-v4-baseline.md).
