# Fuzzing Suite Report

## Suite Overview

**Protocol:** Ophis CoW-settlement solver-allowlist governance layer. This is a
no-funds, access-control state machine — there is no token custody or accounting
logic in scope.

**In-scope contracts:**
- `AllowListGuardian` (Ophis-authored) — SLOW-add / FAST-evict governance wrapper.
- `GPv2AllowListAuthentication` (CoW core + Ophis MED-1 two-step-manager-transfer
  hardening) — the underlying solver + manager state machine.

The rest of `src/` is vendored `cowprotocol/contracts` (upstream-audited CoW core)
and is explicitly **out of scope** — no handlers target it.

**Suite location:** `test/fizz/`

**Handlers:** 2 files —
- `AllowListGuardianHandler.sol`
- `GPv2AllowListAuthenticationHandler.sol`

~40 public handler entry points total, including correct-role paths, adversarial
wrong-role paths, boundary-stress variants, 4 cross-role variants, a back-to-back
same-block variant, and 1 bespoke 4-call manager round-trip.

**Selected entry points:**
- `AllowListGuardian`: `addSolver`, `removeSolver`, `setManager`, `setGuardian`
- `GPv2AllowListAuthentication`: `addSolver`, `removeSolver`, `proposeManager`,
  `acceptManagership`, `setManager`, `cancelManagerTransfer`, `initializeManager`

**Properties:** 45 total — 19 global (`public property_*`) + 26 specific
(`internal property_*`). 13 GL implemented `[x]`, 6 GL documentary `[-]`, 26 SP
implemented `[x]`. 37 SHOULD-HOLD, 8 EXPLORATORY. Categories: 2 VALID_STATE,
18 STATE_TRANSITION, 6 VARIABLE_TRANSITION, 19 HIGH_LEVEL.

## Coverage Results

| Contract | Lines Covered | Coverage | Target | Status |
|---|---|---|---|---|
| `AllowListGuardian.sol` | 20/20 | 100% | 80%+ | ✅ |
| `GPv2AllowListAuthentication.sol` | 30/31 | 96% | 80%+ | ✅ |
| `GPv2EIP1967` (library) | — | 100% | — | ✅ |
| `Initializable.sol` | — | 100% | — | ✅ |
| Vendored `cowprotocol/contracts` (rest of `src/`) | — | 0% (expected) | out-of-scope | N/A — no handlers |

Legend: ✅ = at or above target. Both focus contracts ✅.

`via_ir` is disabled (`foundry.toml`: `via_ir = false`), so these Medusa coverage
numbers are accurate with no Yul-IR deflation. An earlier coverage-focused
checkpoint (`fizz_data/coverage-targets.md`, cycle 1, smaller handler set) had
recorded 83%/85%; the final 500k-testLimit campaign with the full handler and
property set reached the 100%/96% figures above.

## Skipped Paths

- **Vendored CoW core (out of scope, no handlers, upstream-audited):**
  `GPv2Settlement`, `GPv2VaultRelayer`, `GPv2Signing`, `StorageAccessible`,
  `ReentrancyGuard`, the `reader/*` storage readers, vendored test fixtures
  (`ChiToken`, `NonStandardERC20`, `SmartSellOrder`, `ERC20PresetPermit`,
  `GPv2AllowListAuthenticationV2`), and the GPv2 libraries (`GPv2Transfer`,
  `GPv2Order`, `GPv2Trade`, `GPv2SafeERC20`, `SafeMath`, etc.). The incidental
  1-16% hits some of these show come only from constructor/library calls made
  while deploying the two in-scope contracts.
- **`simulateDelegatecall` introspection plumbing** — the single uncovered line
  in `GPv2AllowListAuthentication.sol`, inherited from `StorageAccessible`. Not a
  governance entry point, no handler targets it, out of scope.
- **The 6 `[-]` documentary global properties** — no clean always-true runtime
  assertion exists for these; the guarantee is verified at the source level
  instead: `GL-01`, `GL-07`, `GL-10`, `GL-11`, `GL-12`, `GL-15`.

## Campaign Results

**Fuzzer:** Medusa (default profile), `--timeout 600`, ran to the 500k testLimit.

**Result:** 53 assertion tests passed, 5 failed. The 5 failing handler entry
points (each property fires via both its clamped and unclamped variant) map to
exactly **3 distinct violated properties**: `SP-21`, `SP-23`, `SP-24`.

**0 SHOULD-HOLD violations** — all 37 SHOULD-HOLD properties held for the full
campaign. All 3 violations are `EXPLORATORY` and were *designed* to fire
(EXPECTED-VIOLATED leads per `fizz_data/property-plan.md`); they trace to one
documented root cause — the X-1 binding
(`authentication.manager() == address(allowListGuardian)`) is unenforced
on-chain (`x-ray/invariants.md` X-1: "on-chain: No — install-script
responsibility"). Every call in every violating sequence is individually
authorized. These are leads for human review, not protocol bugs.

**Methodology note (harness fixes, not protocol findings):** two harness bugs
were found and fixed mid-development, before the final campaign: (a) the
`GL-03`/`SP-17` ghosts did not account for `setGuardian` legitimately rotating
the guardian role onto an actor/timelock (fixed to check the live mutable
`guardian` instead of a stale cached role); (b) `SP-15` (the strict converse of
the accept edge, `VS-04`) false-fired on the legitimate coincidental
`setManager(x == pendingManager)` match (relaxed to accept the `setManager`
path via a ghost-tagged disambiguation). After both fixes, `GL-03`/`SP-17`/`SP-15`
all pass cleanly in the final campaign.

### Violation Details

#### SP-21 — `property_guardianNeverGetsInstantAdd`

- **Property violated:** SP-21 — guardian must never gain instant, undelayed,
  unmonitored solver-add capability once it becomes manager.
- **Guarantee:** EXPLORATORY (EXPECTED-VIOLATED lead)
- **Assertion:** `t(!ghosts.guardianBecameManagerThenInstantAdded, "SP-21: guardian gained instant add (X-1 inversion lead)")`
- **Root cause:** unenforced X-1 binding. Once `manager()` is retargeted to
  `GUARDIAN_ROLE` via an individually-authorized `proposeManager` + `acceptManagership`
  (or `setManager`), `GUARDIAN_ROLE` can call `addSolver` directly with zero delay
  and no `SolverAddedViaTimelock` event, inverting the SLOW-add/FAST-evict design.
- **Severity assessment:** needs human review — every call in the sequence
  (propose, accept, addSolver) is individually authorized by the role that made
  it; this is the designed EXPECTED-VIOLATED lead about a deployment-time
  binding, not a code-level bug.
- **Reproducing sequence:** admin `proposeManager(GUARDIAN_ROLE)` → guardian
  `acceptManagership()` → guardian `addSolver(s)`.
- **Foundry repro:** `test_repro_SP21_guardianGainsInstantAdd` — PASS
  (deterministic minimal reproduction, `test/fizz/FoundryTester.sol`).

#### SP-23 — `property_evictLivenessLostIfX1Broken`

- **Property violated:** SP-23 — the timelock's own `setManager` off the
  Guardian must never silently disable guardian eviction liveness.
- **Guarantee:** EXPLORATORY (EXPECTED-VIOLATED lead)
- **Assertion:** `t(!ghosts.evictBlockedByBrokenBinding, "SP-23: timelock broke X-1 binding, guardian eviction silently disabled (lead)")`
- **Root cause:** unenforced X-1 binding. `AllowListGuardian.setManager(x != address(allowListGuardian))`
  is a fully authorized timelock action with no guard preventing it from moving
  `manager` off the Guardian; once moved, `guardian.removeSolver()` forwards and
  reverts one level deeper ("GPv2: caller not manager").
- **Severity assessment:** needs human review — the triggering call is ordinary,
  individually-authorized governance (the timelock's own `setManager`); the
  finding is that X-2's fail-safe-eviction guarantee is only conditional on
  X-1, which the x-ray docs already flag as unenforced on-chain.
- **Reproducing sequence:** timelock `AllowListGuardian.setManager(actor)`
  (moves manager off the Guardian) → guardian `AllowListGuardian.removeSolver(s)`
  reverts.
- **Foundry repro:** `test_repro_SP23_timelockBreaksEvictLiveness` — PASS
  (deterministic minimal reproduction, `test/fizz/FoundryTester.sol`).

#### SP-24 — `property_zeroManagerBricksBothPaths`

- **Property violated:** SP-24 — a direct `setManager(0)` must never brick both
  the add and remove paths system-wide.
- **Guarantee:** EXPLORATORY (EXPECTED-VIOLATED lead)
- **Assertion:** `t(!ghosts.bothPathsBrickedByZeroManager, "SP-24: setManager(0) bricked both add and remove paths (lead)")`
- **Root cause:** unenforced X-1 binding, compounded by the lack of a zero-check
  at the authenticator layer (x-ray I-3). A single direct
  `authentication.setManager(0)` simultaneously breaks the direct `onlyManager`
  gate and breaks X-1 (the Guardian is no longer manager), bricking both add
  and remove until recovery.
- **Severity assessment:** needs human review — the triggering call is
  authorized (by whoever holds `manager` or the EIP-1967 admin at the time),
  and the brick is recoverable via the immutable EIP-1967 admin (`SP-25`, which
  held throughout the campaign), so this is not a permanent DoS — but the
  momentary total lockout is worth a deliberate design decision.
- **Reproducing sequence:** manager/admin `authentication.setManager(address(0))`
  → both the direct `authentication.addSolver`/`removeSolver` path and the
  `AllowListGuardian`-forwarded path revert.
- **Foundry repro:** `test_repro_SP24_zeroManagerBricksBothPaths` — PASS
  (deterministic minimal reproduction, `test/fizz/FoundryTester.sol`).

All three Foundry repros are cleaner, hand-authored, deterministic minimal
reproductions of the exact mechanism — simpler than the 23-call shrunk fuzz
sequences Medusa produced.

## Properties Implemented

| # | Spec ID | Function Name | Type | Guarantee | Confidence | Note |
|---|---|---|---|---|---|---|
| 1 | GL-01 | `property_guardianAuthorityIsX1Binding` | Global | SHOULD-HOLD | LOW | Documentary only — asserting X-1 directly would false-positive on the legitimate state where the timelock has migrated manager() away; real teeth are in SP-05/06/07 + GL-04. |
| 2 | GL-02 | `property_noUnauthorizedGuardianAddOrRotate` | Global | SHOULD-HOLD | HIGH | Ghost-tracked access-control invariant; held for the full campaign. |
| 3 | GL-03 | `property_noUnauthorizedGuardianRemove` | Global | SHOULD-HOLD | HIGH | Ghost-tracked; fixed mid-run to check the live mutable `guardian` (setGuardian legitimately rotates it onto an actor/timelock). |
| 4 | GL-04 | `property_directAuthExactAccessControl` | Global | SHOULD-HOLD | HIGH | Ghost-tracked access-control invariant; held. |
| 5 | GL-05 | `property_adminAuthorityPersistsAcrossHandoffs` | Global | SHOULD-HOLD | HIGH | Live-probe via side-effect-light `cancelManagerTransfer`; held every call. |
| 6 | GL-06 | `property_adminEqualsTimelockUnenforced` | Global | EXPLORATORY | HIGH | Live equality check; the coincidence held for the whole campaign. |
| 7 | GL-07 | `property_x1RestorationRequiresDirectCall` | Global | EXPLORATORY | LOW | Documentary stub — path/reachability fact, no non-brittle ghost wired. |
| 8 | GL-08 | `property_crossContractStorageIsolation` | Global | SHOULD-HOLD | HIGH | Held. |
| 9 | GL-09 | `property_noStaleOrNonExactAccept` | Global | SHOULD-HOLD | HIGH | Ghost-tracked; held. |
| 10 | GL-10 | `property_managerWriterSetExact` | Global | SHOULD-HOLD | LOW | Documentary stub — writer-set exactness (3 assign sites) is source-level, not observable per-call without a writer-tag ghost. |
| 11 | GL-11 | `property_pendingManagerWriterSetExact` | Global | SHOULD-HOLD | LOW | Documentary stub — same rationale as GL-10. |
| 12 | GL-12 | `property_guardianWriterSetExact` | Global | SHOULD-HOLD | LOW | Documentary stub — writer-set exactness is source-level (2 assign sites); non-zero teeth covered by GL-13. |
| 13 | GL-13 | `property_guardianNeverZero` | Global | SHOULD-HOLD | HIGH | Held. |
| 14 | GL-14 | `property_timelockAndAuthenticatorImmutable` | Global | SHOULD-HOLD | HIGH | Compiler-enforced immutable; held trivially. |
| 15 | GL-15 | `property_managerZeroOnlyViaDirectSetManager` | Global | SHOULD-HOLD | LOW | Documentary stub — path/reachability fact; mechanics covered by SP-12/SP-16/SP-24. |
| 16 | GL-16 | `property_adminSlotNeverDrifts` | Global | SHOULD-HOLD | HIGH | Held; no in-scope function calls `setAdmin`. |
| 17 | GL-17 | `property_initializerPermanentlyClosed` | Global | SHOULD-HOLD | HIGH | Held; one-way latch confirmed every call. |
| 18 | GL-18 | `property_managerZeroFailSafeState` | Global | SHOULD-HOLD | HIGH | VALID_STATE conditional; held whenever manager==0 was reached. |
| 19 | GL-19 | `property_pendingManagerGrantsNoPrivilege` | Global | SHOULD-HOLD | HIGH | VALID_STATE conditional; held whenever a pending proposal existed. |
| 20 | SP-01 | `property_solverSetAbsorbingAndIdempotent` | Specific | SHOULD-HOLD | HIGH | Held on both the Guardian-forwarded and direct paths. |
| 21 | SP-02 | `property_proposeCancelRoundTrip` | Specific | SHOULD-HOLD | HIGH | Held. |
| 22 | SP-03 | `property_cancelIsSafeNoOp` | Specific | SHOULD-HOLD | HIGH | Held. |
| 23 | SP-04 | `property_managerRoundTripReversible` | Specific | EXPLORATORY | HIGH | Bespoke 4-call round-trip handler; held cleanly, no residual state observed. |
| 24 | SP-05 | `property_guardianAddSolverPostcondition` | Specific | SHOULD-HOLD | HIGH | Held. |
| 25 | SP-06 | `property_guardianRemoveSolverPostcondition` | Specific | SHOULD-HOLD | HIGH | Held. |
| 26 | SP-07 | `property_guardianSetManagerPostcondition` | Specific | SHOULD-HOLD | HIGH | Held. |
| 27 | SP-08 | `property_guardianSetGuardianTouchesNoAuth` | Specific | SHOULD-HOLD | HIGH | Held. |
| 28 | SP-09 | `property_directAddSolverIffManager` | Specific | SHOULD-HOLD | HIGH | Held. |
| 29 | SP-10 | `property_directRemoveSolverIffManager` | Specific | SHOULD-HOLD | HIGH | Held. |
| 30 | SP-11 | `property_solverOpFrameCondition` | Specific | SHOULD-HOLD | HIGH | Held; frame condition intact across both add/remove paths. |
| 31 | SP-12 | `property_directSetManagerAtomicPair` | Specific | SHOULD-HOLD | HIGH | Held for any `m` incl. 0. |
| 32 | SP-13 | `property_proposeManagerUnconditional` | Specific | SHOULD-HOLD | HIGH | Held; never reverted for any input. |
| 33 | SP-14 | `property_acceptManagershipAtomicPair` | Specific | SHOULD-HOLD | HIGH | Held. |
| 34 | SP-15 | `property_managerPromotionOnlyViaAccept` | Specific | EXPLORATORY | MEDIUM | Mid-run false-fire fixed by relaxing to accept the legitimate coincidental `setManager(x==pendingManager)` path via ghost-tagged disambiguation; passes now, but the tag-based logic is more delicate than a pure state check. |
| 35 | SP-16 | `property_acceptNeverZerosManager` | Specific | SHOULD-HOLD | HIGH | Held. |
| 36 | SP-17 | `property_crossRoleRejection` | Specific | SHOULD-HOLD | HIGH | Ghost-tracked; fixed mid-run alongside GL-03 for the same legitimate-rotation ghost gap. |
| 37 | SP-18 | `property_guardianCannotSelfEntrench` | Specific | SHOULD-HOLD | HIGH | Held. |
| 38 | SP-19 | `property_pendingManagerSlotProtected` | Specific | SHOULD-HOLD | HIGH | Held. |
| 39 | SP-20 | `property_noOnChainDelayEnforced` | Specific | SHOULD-HOLD | HIGH | Held; back-to-back same-block variant confirms no on-chain delay. |
| 40 | SP-21 | `property_guardianNeverGetsInstantAdd` | Specific | EXPLORATORY | HIGH | EXPECTED-VIOLATED lead — fired as designed (see Violation Details); Foundry repro confirms the exact mechanism. |
| 41 | SP-22 | `property_evictLivenessWhileX1Held` | Specific | SHOULD-HOLD | HIGH | Held while X-1 was intact. |
| 42 | SP-23 | `property_evictLivenessLostIfX1Broken` | Specific | EXPLORATORY | HIGH | EXPECTED-VIOLATED lead — fired as designed (see Violation Details). |
| 43 | SP-24 | `property_zeroManagerBricksBothPaths` | Specific | EXPLORATORY | HIGH | EXPECTED-VIOLATED lead — fired as designed (see Violation Details). |
| 44 | SP-25 | `property_adminRescueAlwaysLive` | Specific | SHOULD-HOLD | HIGH | Held; admin rescue never failed, incl. recovering from SP-24's zero-manager brick. |
| 45 | SP-26 | `property_x1BrokenDeadCodeAndRawPower` | Specific | EXPLORATORY | MEDIUM | EXPECTED-VIOLATED composite lead — did NOT fire in this campaign (unlike SP-21/SP-23 individually); the exact triple-AND ordering was not produced by this corpus, so the absence of a fire is not strong evidence the composite scenario can't occur — candidate for a longer/targeted run. |

## Open TODOs

`grep -rn "TODO" test/fizz/` returns 5 hits, all in `test/fizz/Properties.sol`,
all marking intentional documentary-only stubs (not unfinished implementation
work):

| File | Line | Spec ID | Note |
|---|---|---|---|
| `test/fizz/Properties.sol` | 72 | GL-07 | "Which call-site restored X-1" is a path/reachability fact, not checkable as a non-brittle global assertion. |
| `test/fizz/Properties.sol` | 95 | GL-10 | Writer-set exactness (3 assign sites) is a source-level fact, not observable per-call without a writer-tag ghost. |
| `test/fizz/Properties.sol` | 105 | GL-11 | Same rationale as GL-10. |
| `test/fizz/Properties.sol` | 113 | GL-12 | Writer-set exactness (2 assign sites); non-zero teeth already covered by GL-13. |
| `test/fizz/Properties.sol` | 136 | GL-15 | "Reached 0 only via this call-site" is a path/reachability fact; mechanics covered by SP-12/SP-16/SP-24. |

`GL-01` shares the same documentary-only status but has no in-code `TODO` tag
(it is a deliberate design note, not a marked follow-up). None of these 5
represent missing implementation — see Next Steps item 2 if strengthening them
is desired.

## Next Steps

1. Human-review the 3 X-1 leads (`SP-21`, `SP-23`, `SP-24`) — decide whether
   `AllowListGuardian.setManager` should refuse to move `manager` off itself,
   or whether the X-1 binding (`manager() == address(allowListGuardian)`)
   should be asserted on-chain instead of being left as an install-script
   responsibility.
2. Strengthen/implement the 6 `[-]` documentary globals (`GL-01`, `GL-07`,
   `GL-10`, `GL-11`, `GL-12`, `GL-15`) if desired — this would require
   writer-tag ghosts at every assignment site to turn them into non-brittle
   runtime assertions; they are currently source-verified instead.
3. `GPv2AllowListAuthentication.sol` at 96% is effectively complete — the 1
   uncovered line is the out-of-scope inherited `simulateDelegatecall`
   introspection plumbing, not governance logic.
4. Recommended production campaign duration: the current 600s / 500k-testLimit
   run is ample for this small access-control surface; suggest a longer
   overnight Medusa run plus a complementary Echidna pass for cross-fuzzer
   confidence.
5. Note the existing complementary harnesses already cover the pure "no
   unauthorized mutation" property from a different angle:
   `echidna/E2EAllowList.sol` + `E2EAllowListGuardian.sol` (Echidna) and the
   Lean proofs under `verity/`. This fizz suite is isolated under
   `test/fizz/` + `fizz_data/` and does not conflict with them.

---

**Manual campaign commands** (for a follow-up run outside this report):
- Medusa: `medusa fuzz` (from project root)
- Echidna: `echidna . --contract FuzzTester --config echidna.yaml`
