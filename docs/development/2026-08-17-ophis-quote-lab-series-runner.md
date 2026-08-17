# Ophis Quote Lab time-series runner

**Date:** 2026-08-17

**Scope:** Local, read-only Ethereum measurement infrastructure

**Execution/publication:** None

## Boundary

The `series` command repeats a quote matrix across distinct Ethereum blocks and
aggregates source reliability, wins, and latency over all observations.

- 2–24 samples per invocation;
- 12–3,600 seconds between completed samples;
- one canonical EIP-1898 block hash per sample;
- every later sample must have a strictly higher block number;
- duplicate or non-advancing blocks fail the whole series;
- quote failures remain observations and are never retried or substituted;
- no router calldata, settlement simulation, signing, or submission.

Each serialized result retains the complete per-block runs as well as an
aggregate summary. This keeps the evidence auditable instead of collapsing it
into a success percentage.

## Two-sample smoke run

The 10-case control matrix was run against six Ophis sources with a 12-second
interval:

- first block: `25774363`, hash
  `0x576e0c14480ec8b182d10365c726afcb0ebbe70fb64e2ec0e4285402cb8ffe31`;
- last block: `25774365`, hash
  `0x3db91e8e2817bd3dfc0a45ffc676d45dbab58606b3a94ce6eae517d18b3c6625`;
- total observations: 120;
- retries: none.

| Ophis source | Success | Winning cases | Outright wins | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed fixture | 20/20 | 20 | 0 | 145.390 ms | 215.794 ms |
| Prior fixture | 20/20 | 20 | 0 | 145.833 ms | 264.760 ms |
| Current fixture | 8/20 | 8 | 0 | 103.574 ms | 160.739 ms |
| V3 baseline | 20/20 | 20 | 0 | 143.229 ms | 233.082 ms |
| V2 direct baseline | 20/20 | 0 | 0 | 32.624 ms | 39.540 ms |
| V4 hookless baseline | 12/20 | 0 | 0 | 158.975 ms | 212.624 ms |

The current fixture succeeded in the four non-USDC cases and failed in all six
USDC cases in both samples. The smoke run therefore reproduces the earlier
pair-specific pattern over advancing blocks.

This two-sample result validates the runner, not the economic decision. A
production-quality window still needs more samples, explicit RPC diversity,
and the net-surplus model.

## Validation

- `cargo test -p ophis-quote-lab`: 13 passed
- `cargo clippy -p ophis-quote-lab --all-targets -- -D warnings`: passed;
  only two pre-existing invalid-path warnings from the workspace Clippy config
- local source scan: no forbidden external branding in the Ophis lab or its
  evidence files

## Decision

Decision Gate 1 remains closed. No execution adapter, push, pull request,
deployment, or release is authorized.
