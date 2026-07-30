# Fuzzing Suite Report

## Suite Overview
- **Project**: Ophis solver-allowlist governance layer
- **Suite location**: `test/fizz/`
- **Contracts targeted**: `AllowListGuardian`, `GPv2AllowListAuthentication`
- **Total handlers**: 11 (8 primary, 3 secondary/dispatcher)
- **Properties**: 45 (19 global, 26 function-specific)

## Coverage Results
| Contract | Target | Achieved | Status |
|----------|--------|----------|--------|
| `AllowListGuardian` | 80% | 100% | ✅ |
| `GPv2AllowListAuthentication` | 80% | 96% | ✅ |

Status legend: ✅ if achieved ≥ target (or intentional skip), ⚠️ if within 10 points below target, ❌ if more than 10 points below target.

## Skipped Paths
| Contract | Function / Path | Reason |
|----------|----------------|--------|
| `GPv2AllowListAuthentication` | `simulateDelegatecall`, `simulateDelegatecallInternal` | Proxy simulation helpers are not governance state-machine entry points. |
| `GPv2AllowListAuthentication` | `isSolver` | View-only path; exercised indirectly by property assertions rather than a handler. |
| `GPv2Settlement`, `GPv2VaultRelayer`, readers and GPv2 libraries | All | Vendored upstream CoW core; outside the Ophis-authored governance-layer fuzz scope. |
| Test fixtures and mocks | All | Non-production support contracts. |

## Campaign Results
- **Fuzzer used**: Medusa
- **Duration**: 36 seconds (last recorded fuzz progress)
- **Total calls**: 540,381 (last recorded fuzz progress)
- **Branches hit**: 1,638
- **Corpus size**: 130
- **Violations found**: 5 assertion surfaces, grouped into 3 distinct expected exploratory root causes; 0 SHOULD-HOLD violations

### Violation Details

#### SP-21 — Guardian gains instant solver-add authority
- **Property violated**: `property_guardianNeverGetsInstantAdd`
- **Guarantee**: `EXPLORATORY`
- **Assertion**: `!ghosts.guardianBecameManagerThenInstantAdded`
- **Root cause**: An authorized admin/manager handoff can make `GUARDIAN_ROLE` the authenticator manager; it can then call `addSolver` directly without the Guardian wrapper, timelock delay, or wrapper event. Multiple failing handler surfaces share this root cause.
- **Severity assessment**: `needs human review`
- **Reproducing sequence**: Admin calls `authentication.setManager(GUARDIAN_ROLE)` (or propose/accept); `GUARDIAN_ROLE` calls `authentication.addSolver(solver)`.
- **Foundry repro**: `test_repro_SP21_guardianGainsInstantAdd` in `FoundryTester.sol` — `PASS` (violation reproduces)

#### SP-23 — Manager migration disables guardian eviction
- **Property violated**: `property_evictLivenessLostIfX1Broken`
- **Guarantee**: `EXPLORATORY`
- **Assertion**: `!ghosts.timelockBrokeEvictBinding && !ghosts.evictBlockedByBrokenBinding`
- **Root cause**: An authorized timelock call can move `manager` away from the `AllowListGuardian`, breaking the unenforced X-1 binding; later guardian removals revert at the authenticator's manager gate. Multiple failing handler surfaces share this root cause.
- **Severity assessment**: `needs human review`
- **Reproducing sequence**: Timelock adds a solver, calls `allowListGuardian.setManager(newManager)`, then guardian calls `allowListGuardian.removeSolver(solver)` and the forwarded call reverts.
- **Foundry repro**: `test_repro_SP23_timelockBreaksEvictLiveness` in `FoundryTester.sol` — `PASS` (violation reproduces)

#### SP-24 — Zero manager temporarily bricks both paths
- **Property violated**: `property_zeroManagerBricksBothPaths`
- **Guarantee**: `EXPLORATORY`
- **Assertion**: `!ghosts.bothPathsBrickedByZeroManager`
- **Root cause**: Direct `authentication.setManager(address(0))` is allowed for the current manager/admin and disables both direct manager-gated operations and Guardian forwarding until the EIP-1967 admin restores a nonzero manager. Multiple failing handler surfaces share this root cause.
- **Severity assessment**: `needs human review`
- **Reproducing sequence**: Admin calls `authentication.setManager(address(0))`; Guardian add/remove forwards revert; admin restores `manager` to the Guardian.
- **Foundry repro**: `test_repro_SP24_zeroManagerBricksBothPaths` in `FoundryTester.sol` — `PASS` (violation reproduces)

## Properties Implemented
| # | Property | Type | Guarantee | Confidence |
|---|----------|------|-----------|------------|
| GL-01 | `property_guardianAuthorityIsX1Binding` | Global | SHOULD-HOLD | LOW — documenting-only stub |
| GL-02 | `property_noUnauthorizedGuardianAddOrRotate` | Global | SHOULD-HOLD | HIGH |
| GL-03 | `property_noUnauthorizedGuardianRemove` | Global | SHOULD-HOLD | HIGH |
| GL-04 | `property_directAuthExactAccessControl` | Global | SHOULD-HOLD | HIGH |
| GL-05 | `property_adminAuthorityPersistsAcrossHandoffs` | Global | SHOULD-HOLD | HIGH |
| GL-06 | `property_adminEqualsTimelockUnenforced` | Global | EXPLORATORY | MEDIUM — validates the configured harness binding only |
| GL-07 | `property_x1RestorationRequiresDirectCall` | Global | EXPLORATORY | LOW — documenting-only stub |
| GL-08 | `property_crossContractStorageIsolation` | Global | SHOULD-HOLD | MEDIUM — checks immutable bindings, not every storage slot |
| GL-09 | `property_noStaleOrNonExactAccept` | Global | SHOULD-HOLD | HIGH |
| GL-10 | `property_managerWriterSetExact` | Global | SHOULD-HOLD | LOW — documenting-only stub |
| GL-11 | `property_pendingManagerWriterSetExact` | Global | SHOULD-HOLD | LOW — documenting-only stub |
| GL-12 | `property_guardianWriterSetExact` | Global | SHOULD-HOLD | LOW — documenting-only stub |
| GL-13 | `property_guardianNeverZero` | Global | SHOULD-HOLD | HIGH |
| GL-14 | `property_timelockAndAuthenticatorImmutable` | Global | SHOULD-HOLD | HIGH |
| GL-15 | `property_managerZeroOnlyViaDirectSetManager` | Global | SHOULD-HOLD | LOW — documenting-only stub |
| GL-16 | `property_adminSlotNeverDrifts` | Global | SHOULD-HOLD | HIGH |
| GL-17 | `property_initializerPermanentlyClosed` | Global | SHOULD-HOLD | HIGH |
| GL-18 | `property_managerZeroFailSafeState` | Global | SHOULD-HOLD | MEDIUM — probes one fuzz actor and add path |
| GL-19 | `property_pendingManagerGrantsNoPrivilege` | Global | SHOULD-HOLD | MEDIUM — probes add privilege directly |
| SP-01 | `property_solverSetAbsorbingAndIdempotent` | Specific | SHOULD-HOLD | HIGH |
| SP-02 | `property_proposeCancelRoundTrip` | Specific | SHOULD-HOLD | HIGH |
| SP-03 | `property_cancelIsSafeNoOp` | Specific | SHOULD-HOLD | HIGH |
| SP-04 | `property_managerRoundTripReversible` | Specific | EXPLORATORY | HIGH |
| SP-05 | `property_guardianAddSolverPostcondition` | Specific | SHOULD-HOLD | HIGH |
| SP-06 | `property_guardianRemoveSolverPostcondition` | Specific | SHOULD-HOLD | HIGH |
| SP-07 | `property_guardianSetManagerPostcondition` | Specific | SHOULD-HOLD | HIGH |
| SP-08 | `property_guardianSetGuardianTouchesNoAuth` | Specific | SHOULD-HOLD | HIGH |
| SP-09 | `property_directAddSolverIffManager` | Specific | SHOULD-HOLD | HIGH |
| SP-10 | `property_directRemoveSolverIffManager` | Specific | SHOULD-HOLD | HIGH |
| SP-11 | `property_solverOpFrameCondition` | Specific | SHOULD-HOLD | MEDIUM — bounded to six governance-relevant addresses |
| SP-12 | `property_directSetManagerAtomicPair` | Specific | SHOULD-HOLD | HIGH |
| SP-13 | `property_proposeManagerUnconditional` | Specific | SHOULD-HOLD | HIGH |
| SP-14 | `property_acceptManagershipAtomicPair` | Specific | SHOULD-HOLD | HIGH |
| SP-15 | `property_managerPromotionOnlyViaAccept` | Specific | EXPLORATORY | HIGH |
| SP-16 | `property_acceptNeverZerosManager` | Specific | SHOULD-HOLD | HIGH |
| SP-17 | `property_crossRoleRejection` | Specific | SHOULD-HOLD | HIGH |
| SP-18 | `property_guardianCannotSelfEntrench` | Specific | SHOULD-HOLD | HIGH |
| SP-19 | `property_pendingManagerSlotProtected` | Specific | SHOULD-HOLD | HIGH |
| SP-20 | `property_noOnChainDelayEnforced` | Specific | SHOULD-HOLD | HIGH |
| SP-21 | `property_guardianNeverGetsInstantAdd` | Specific | EXPLORATORY | HIGH — intentionally fires on the documented lead |
| SP-22 | `property_evictLivenessWhileX1Held` | Specific | SHOULD-HOLD | HIGH |
| SP-23 | `property_evictLivenessLostIfX1Broken` | Specific | EXPLORATORY | HIGH — intentionally fires on the documented lead |
| SP-24 | `property_zeroManagerBricksBothPaths` | Specific | EXPLORATORY | HIGH — intentionally fires on the documented lead |
| SP-25 | `property_adminRescueAlwaysLive` | Specific | SHOULD-HOLD | HIGH |
| SP-26 | `property_x1BrokenDeadCodeAndRawPower` | Specific | EXPLORATORY | HIGH — intentionally probes the documented X-1 break |

Implementation status: 39 properties are marked `[x]`; GL-01, GL-07, GL-10, GL-11, GL-12, and GL-15 are marked `[-]` and remain documenting/manual stubs.

## Open TODOs
- `test/fizz/Properties.sol:72` — GL-07 needs a previous-call/path ghost to prove X-1 restoration provenance.
- `test/fizz/Properties.sol:95` — GL-10 needs writer-tag instrumentation for every manager assignment path.
- `test/fizz/Properties.sol:105` — GL-11 needs writer-tag instrumentation for every pending-manager assignment path.
- `test/fizz/Properties.sol:113` — GL-12 needs writer-tag instrumentation for guardian assignment provenance.
- `test/fizz/Properties.sol:136` — GL-15 needs writer-tag instrumentation to prove the exact zero-manager transition source.

## Next Steps
1. Decide whether X-1 is a deployment convention or a required invariant. If required, prevent arbitrary manager migration or explicitly preserve a guardian emergency-eviction path.
2. Reject `address(0)` in direct `setManager`, or document and operationally monitor the temporary brick/recovery procedure.
3. Replace the six LOW-confidence documenting stubs with transition ghosts or source-level invariant checks; prioritize GL-10, GL-11, and GL-15.
4. Expand GL-18/GL-19 privilege probes across all actors and manager-control operations, and expand SP-11's address set if integrations add privileged accounts.
5. Run a production validation campaign for at least 10 minutes and retain the corpus; the current recorded fuzz phase was 36 seconds.

Manual campaign commands:

```sh
medusa fuzz
echidna test/fizz/FuzzTester.sol --contract FuzzTester --config echidna.yaml
```
