# Ophis Quote Lab V3 baseline evidence

**Date:** 2026-08-17

**Scope:** Local, read-only Ethereum shadow measurement

**Execution/publication:** None

## Baseline added

Ophis Quote Lab now has a pinned single-pool V3 baseline. It calls the canonical Quoter V2 interface at fee tiers 1, 5, 30, and 100 basis points, all at the matrix's one EIP-1898 block hash.

The baseline:

- supports exact-input observations only;
- verifies the quoter runtime hash before every observation;
- records successful fee-tier candidates and the quoter-returned gas estimate;
- treats individual fee-tier reverts as unavailable pools;
- fails the observation if all four tiers fail;
- cannot build, accept, sign, or submit execution calldata.

Pinned identity:

| Item             | Value                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Address          | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`                                                                             |
| Runtime hash     | `0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b`                                                     |
| Interface source | [Uniswap V3 periphery `IQuoterV2`](https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/IQuoterV2.sol) |

The address and runtime hash matched through three independent public Ethereum RPC providers on 2026-08-17.

## Manifest verification

At Ethereum block `25774251`, hash `0x5962ebce8191797d061e92a0578888d57bdb08dd6112c96fc2d0138070e3442a`, all 12 manifest runtimes matched, including the new baseline.

## Provider A matrix

- Block: `25774252`
- Hash: `0x995542101253c12db3376cdfab1cd14ce2790e11a549e8ed12ef2e58d2b3dad0`
- Cases: the existing 10 WETH/USDC and WETH/DAI exact-input cases
- Retries or source substitution: none

| Ophis source    | Success |    Wins |        p50 |        p95 |
| --------------- | ------: | ------: | ---------: | ---------: |
| Fixed fixture   |   10/10 | 10 ties | 149.299 ms | 527.799 ms |
| Prior fixture   |   10/10 | 10 ties | 170.474 ms | 289.055 ms |
| Current fixture |    4/10 |  4 ties | 120.459 ms | 265.779 ms |
| V3 baseline     |   10/10 | 10 ties | 137.280 ms | 290.414 ms |

The fixed and prior fixtures' best outputs exactly matched the V3 baseline in all 10 cases. The current fixture exactly matched it in its four successful DAI cases and reverted in all six USDC cases.

This sample therefore shows no output improvement over the V3 baseline. It confirms that the aggregate fixtures selected the same V3 pool result for every tested input.

The baseline's selected-pool gas estimates ranged from `87,428` through `193,950`; these are values returned by the quoter, not measurements of total RPC work or end-to-end Ophis settlement gas.

## Provider B repeat

Two consecutive runs on a second public RPC provider reproduced a different availability boundary:

- baseline: 10/10;
- fixed fixture: 9/10;
- prior fixture: 9/10;
- current fixture: 4/10.

The fixed and prior fixtures both failed the WETH→USDC 10 WETH case with RPC code `-32000`, `out of gas`. The current fixture again reverted for all six USDC cases. The baseline remained available because it makes four smaller, bounded calls instead of one heavier aggregate call.

The baseline's sole “outright win” on that provider was therefore caused by aggregate-call failure. It is not evidence of a better price.

## Decision

Decision Gate 1 remains closed.

Current evidence says:

1. the current fixture is not reliable enough for production consideration;
2. the fixed and prior fixtures added no economic value over the V3 baseline on this narrow pair matrix;
3. aggregate call reliability depends on provider gas policy;
4. latency from sequential public-RPC runs is descriptive, not a production benchmark;
5. the quoter gas estimate is not yet sufficient for net-surplus comparison.

The next measurement step is to broaden the allowlisted pair matrix to cases where V2, V4, or other existing Ophis liquidity sources can plausibly win, record repeated samples across time and providers, and add a comparable gas model. None of this authorizes an execution adapter.
