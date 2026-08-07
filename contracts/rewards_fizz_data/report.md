# Fuzzing Suite Report

## Suite Overview
- **Project**: Ophis Rewards Distributor
- **Suite location**: `test/rewards/fizz`
- **Contracts targeted**: OphisRewardsDistributor
- **Total handlers**: 3 (2 primary, 1 secondary dispatcher)
- **Properties**: 4 (4 global, 0 function-specific; these implement 5 specification guarantees)

## Coverage Results
| Contract | Target | Achieved | Status |
|----------|--------|----------|--------|
| OphisRewardsDistributor | 80% | 83.7% (72/86 lines) | ✅ |

Status legend: ✅ if achieved ≥ target (or intentional skip), ⚠️ if within 10 points below target, ❌ if more than 10 points below target.

## Skipped Paths
| Contract | Function / Path | Reason |
|----------|----------------|--------|
| OphisRewardsDistributor | Constructor wrong-chain rejection | The harness intentionally pins chain ID 4663; this deployment guard is covered by the Foundry unit suite rather than the stateful campaign. |
| OphisRewardsDistributor | `assign` malformed-signature and invalid-denomination paths | Stateful handlers generate valid EIP-712 signatures and only the two permitted denominations so the campaign can reach assignment and claim lifecycle states; negative cases are covered by Foundry unit tests. |

## Campaign Results
- **Fuzzer used**: Medusa
- **Duration**: 15 seconds (transaction limit reached before the configured 120-second timeout)
- **Total calls**: 566,900
- **Branches hit**: 668
- **Corpus size**: 32
- **Violations found**: 0

### Violation Details

No property violations were recorded. `fizz_data/corpus_medusa/test_results/` contains no violation JSON files, so no Foundry violation repro was required.

## Properties Implemented
| # | Property | Type | Guarantee | Confidence |
|---|----------|------|-----------|------------|
| 1 | `property_inventoryCaps` (GL-01) | Global | SHOULD-HOLD | HIGH — directly checks every ticket, denomination, and value ceiling. |
| 2 | `property_counterConservation` (GL-02, GL-03) | Global | SHOULD-HOLD | HIGH — checks the exact denomination-count identity and both claimed-versus-assigned bounds. |
| 3 | `property_tokenConservation` (GL-04) | Global | SHOULD-HOLD | HIGH — checks exact conservation against the fixed 150 USDG initial funding without tolerance. |
| 4 | `property_ghostCountersMatch` (GL-05) | Global | SHOULD-HOLD | HIGH — exactly compares successful handler-operation ghosts with the contract counters. |

All five entries in `PROPERTIES.md` are marked `[x]`; none are skipped or pending.

## Open TODOs
None. Actors do not supply tokens or approvals in this distributor.

## Next Steps
1. Extend the stateful handler with deliberately invalid signatures and invalid denominations if negative-path campaign coverage is desired; those guards are currently delegated to Foundry unit tests.
2. Run a production-validation Medusa campaign for the full configured 600 seconds rather than stopping at the current transaction limit; raise the test limit so runtime, not transaction count, terminates the run.
3. Run Echidna as a complementary engine after Medusa to diversify sequence generation and execution behavior.

Manual campaign commands from the project root:

- `FOUNDRY_PROFILE=rewards-fuzz medusa fuzz --config medusa.json`
- `FOUNDRY_PROFILE=rewards-fuzz echidna test/rewards/fizz/FuzzTester.sol --contract FuzzTester --config echidna.yaml`
