# Coverage targets

Fuzz profile: via_ir disabled — coverage numbers are accurate.

| Contract | Role | Target |
|---|---|---:|
| OphisRewardsDistributor | finite reward core | 80% |

The wrong-chain constructor branch is unreachable after the harness pins chain ID 4663. Invalid
signature details are covered by Foundry unit tests; the stateful harness generates valid EIP-712
signatures so it can explore the assignment/claim lifecycle.

## Cycle 1 — 2026-08-07

| Contract | Role | Target | Hit | Status |
|---|---|---:|---:|---|
| OphisRewardsDistributor | finite reward core | 80% | 83.7% (72/86 lines) | ✅ |

Medusa executed 566,900 calls across 5,663 sequences. All four properties and all six assertion
targets passed with zero failures. The campaign reached the configured transaction limit.
