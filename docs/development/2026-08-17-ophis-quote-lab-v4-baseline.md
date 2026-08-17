# Ophis Quote Lab V4 hookless baseline

**Date:** 2026-08-17

**Scope:** Local, read-only Ethereum measurement control

**Execution/publication:** None

## Control boundary

Ophis Quote Lab now independently quotes canonical Ethereum V4 pools through
the official quoter's exact-input single-pool function.

- Quoter: `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203`
- Quoter runtime code hash:
  `0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441`
- Pool manager: `0x000000000004444c5dc75cB358380D2e3dE08A90`
- Pool-manager runtime code hash:
  `0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293`
- Function selector: `0xaa9d21cb`
- Allowed `(fee, tick spacing)` pairs:
  `(100, 1)`, `(500, 10)`, `(3,000, 60)`, `(10,000, 200)`
- Hook address: always zero
- Hook data: always empty

The adapter sorts the two ERC-20 currencies, derives swap direction from the
requested input token, rejects amounts above `uint128`, and records the
quoter's gas estimate. The manifest validator rejects any different pool pair
or mismatched fee/spacing list.

It cannot quote hooked pools, native currency, multi-hop paths, exact-output
trades, or arbitrary pool keys. It cannot build or return execution calldata,
simulate a settlement, sign, or submit a transaction.

The quoter and pool-manager addresses came from the verified-address catalog;
the ABI and `PoolKey` layout came from the official V4 periphery and core
interfaces. Both live runtimes matched through independent Ethereum RPC
providers before they were pinned.

## Historical provenance replay

The expanded matrix observed one aggregate V4 win at Ethereum block
`25774279`, hash
`0x6003f6948e82ad8ea6d0d90fc25ff8662aa3b0628b61fc9328cd8f172d5164e0`.
The direct hookless control reproduced it exactly:

| Case | Aggregate output | Direct V4 output | Direct gas estimate | Match |
| --- | ---: | ---: | ---: | ---: |
| USDC→USDT, 1,000 USDC | `1,000,818,092` | `1,000,818,092` | `42,208` | Exact |

Two independent RPC providers returned the same historical output and gas
estimate. This validates the venue, fee, spacing, and hookless pool identity
for the observation. It does not establish positive net surplus.

## Latest-block six-source run

The full 30-case matrix was repeated with all independent controls:

- Block: `25774341`
- Hash: `0xb10695bf084398a50705d9a8421912447d07fc984f154edbb7b9f53a9a7511d3`

| Ophis source | Success | Winning cases | Outright wins | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed fixture | 30/30 | 30 | 0 | 40.554 ms | 191.603 ms |
| Prior fixture | 30/30 | 30 | 0 | 38.859 ms | 188.781 ms |
| Current fixture | 20/30 | 20 | 0 | 38.550 ms | 126.832 ms |
| V3 baseline | 30/30 | 29 | 0 | 139.476 ms | 250.743 ms |
| V2 direct baseline | 30/30 | 0 | 0 | 33.226 ms | 39.096 ms |
| V4 hookless baseline | 10/30 | 1 | 0 | 144.389 ms | 480.565 ms |

The aggregate and direct V4 controls returned the same `1,000,812,452` USDT
base units for the only V4-winning case at this later block. The direct control
failed when all four exact hookless pool keys were absent or unquotable; it did
not substitute a different venue or pool. The current aggregate fixture again
reverted in all ten USDC-related cases.

## Validation

- `cargo test -p ophis-quote-lab`: 12 passed
- `cargo clippy -p ophis-quote-lab --all-targets -- -D warnings`: passed;
  only two pre-existing invalid-path warnings from the workspace Clippy config
- all 15 pinned Ethereum runtimes matched at block `25774340`, hash
  `0x16bfa523c3b299790394f41bd3aebc44bd241c7a851272b440fcb3d228e3ecf2`

## Decision

Decision Gate 1 remains closed. Independent V2, V3, and hookless V4 price
controls are now present, but a one-block matrix is not a production case.
Ophis still needs repeated time-window samples and an end-to-end gas model that
converts output deltas into net surplus. No execution adapter, push, pull
request, deployment, or release is authorized.

The bounded time-series runner follow-up is recorded in
[`2026-08-17-ophis-quote-lab-series-runner.md`](./2026-08-17-ophis-quote-lab-series-runner.md).
