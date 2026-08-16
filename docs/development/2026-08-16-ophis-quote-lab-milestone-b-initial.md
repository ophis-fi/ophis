# Ophis Quote Lab Milestone B initial evidence

**Date:** 2026-08-16

**Scope:** Local, read-only Ethereum availability matrix

**Execution/publication:** None

## Method

Ophis Quote Lab ran 10 exact-input cases covering WETH/USDC and WETH/DAI in
both directions at one canonical Ethereum block. Each case used the same three
Ophis fixture IDs and raw token amounts from
`config/ethereum-matrix.toml`.

- Block: `25770445`
- Block hash:
  `0xf01143cf9ee9983f7444ea6f239343438f7ed875021820c810a5f07ca45cff62`
- EIP-1898: `blockHash` with `requireCanonical = true`
- Runtime provenance: all 11 pinned contract hashes matched at this block
- RPC method boundary: `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`,
  and `eth_call` only
- Retries/substitution: none

## Reliability and latency

| Ophis fixture | Success | Wins | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| Fixed historical | 10/10 | 10 ties | 119.499 ms | 1,590.729 ms | 1,590.729 ms |
| Prior Ethereum | 10/10 | 10 ties | 154.489 ms | 459.536 ms | 459.536 ms |
| Current Ethereum | 4/10 | 4 ties | 103.303 ms | 160.141 ms | 160.141 ms |

Latency includes successful and reverted quote calls. Calls were sequential on
one public RPC endpoint, so this first sample is an availability smoke test,
not a stable provider-performance benchmark.

## Case dataset

| Case | Fixed | Prior | Current | Best output base units |
|---|---:|---:|---:|---:|
| WETH→USDC, 0.1 | Success | Success | Revert | `187486036` |
| WETH→USDC, 1 | Success | Success | Revert | `1874778159` |
| WETH→USDC, 10 | Success | Success | Revert | `18739564989` |
| USDC→WETH, 100 | Success | Success | Revert | `53326240163457513` |
| USDC→WETH, 1,000 | Success | Success | Revert | `533249931551918912` |
| USDC→WETH, 10,000 | Success | Success | Revert | `5331252627946093290` |
| WETH→DAI, 1 | Success | Success | Success | `1868822941777811578558` |
| WETH→DAI, 10 | Success | Success | Success | `18621801684233444514678` |
| DAI→WETH, 1,000 | Success | Success | Success | `532000310426179529` |
| DAI→WETH, 10,000 | Success | Success | Success | `5306767220584680602` |

The fixed and prior fixtures returned identical decoded outputs in all 10
cases. The current fixture returned identical outputs when it succeeded, but
reverted for all six cases involving USDC. This strongly suggests a
pair/dependency-specific availability problem rather than a universal failure.
It does not establish the exact cause.

A hardened repeat at block `25770561`, hash
`0x931543e7900fe6bff14e62a43adb5d543ee05b249d94f78973c976b40f8943c6`,
produced the same 10/10, 10/10, and 4/10 success pattern and the same six
USDC-related reverts. The repeat also enforced a 30-second RPC timeout and
semantic validation of the best amount, source enum, fee, and candidate-set
membership.

## Decision status

Decision Gate 1 is not met. This sample does not yet compare against Ophis's
existing quote sources, normalize gas assumptions, measure RPC gas consumed,
or simulate a locally reconstructed settlement interaction. The observed 40%
success rate for the current fixture is also below any reasonable production
reliability bar.

The next safe measurement step is to add an Ophis baseline adapter for each
relevant existing quote source, keep every comparison on the same block hash,
and repeat the matrix over a time window and multiple RPC providers. No
execution integration should be started from this result.

## Reproduction

From `apps/backend`:

```sh
cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  matrix \
  --source ophis-fixture-fixed \
  --source ophis-fixture-prior \
  --source ophis-fixture-current
```
