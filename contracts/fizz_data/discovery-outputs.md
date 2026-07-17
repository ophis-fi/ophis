# Discovery Agent Outputs (Step 9b) — raw, for the Synthesizer

Protocol: Ophis solver-allowlist governance layer (AllowListGuardian + GPv2AllowListAuthentication).
No-funds access-control state machine. See fizz_data/invariant-context.md for the full model.

Total raw properties: Agent 1 = 0, Agent 2 = 6 (RT), Agent 3 = 32 (ST/VT/VS), Agent 4 = 14 (ADV), Agent 5 = 10 (GOV).

---

## AGENT 1 — Conservation Auditor: ZERO properties

Correctly emitted nothing. No aggregate/total variables exist anywhere in scope. `solvers` is a
`mapping(address=>bool)` membership set with no `solverCount`/`totalSolvers` companion to reconcile
against, so Pattern A has no "tracked whole". No funds → no Pattern B. No documented cross-variable
arithmetic → no Pattern C. Mapping value is `bool` not numeric → no Pattern D. The two suggested
degenerate framings were rejected: "only toggled by authorized paths" is an access-control claim
(Agent 3/4 territory), and "count of authorized mutations == count of authorized-caller calls" is
tautological (no independent second whole to cross-check). Expected outcome for this protocol.

---

## AGENT 2 — Round-Trip & Rounding Analyst: 6 properties (RT-01..RT-06), 0 rounding

Confirmed NO conversion/preview/rounding functions exist (no arithmetic beyond address/bool compares).
Emitted zero RD-* properties. Key nuance: add/remove and setManager/accept are ABSOLUTE OVERWRITES,
not additive inverses — "forward-then-reverse returns to original" is only literally true because the
reverse op forces a fixed value (remove→false, add→true), not because it undoes history. Only infra
change needed: add `address manager;` to Snapshots.State (currently only `_placeholder`).

RT-01 (SPECIFIC, HIGH, SHOULD-HOLD): After successful addSolver(s), isSolver(s)==true; if immediately
followed by successful removeSolver(s), isSolver(s)==false. Unconditional absorbing end-state (remove
always forces false regardless of prior). Both Guardian path (needs manager==Guardian) and direct path
(read manager() live). Evidence: x-ray I-5; GPv2AllowListAuthentication.sol:177,188; NatSpec "idempotent"
:173,184; Guardian forwards :96,123. Implement as two atomic per-call postconditions.

RT-02 (SPECIFIC, MEDIUM, SHOULD-HOLD): Mirror — removeSolver(s) then addSolver(s) ends isSolver(s)==true
(add is absorbing in this order). Same evidence. Rules out a "sticky false" bug.

RT-03 (SPECIFIC, MEDIUM, SHOULD-HOLD): addSolver(s) twice → isSolver(s)==true, no revert; removeSolver(s)
twice → false, no revert. Idempotency. Evidence: NatSpec "This function is idempotent" :173/:184; I-5.

RT-04 (SPECIFIC, HIGH, SHOULD-HOLD): proposeManager(x) then cancelManagerTransfer() (both via TIMELOCK_ROLE
admin branch) ends pendingManager==0 AND manager == its exact pre-propose value (neither fn writes manager).
Genuine forward-then-reverse round trip. Evidence: proposeManager body :140 (only writes pending, reads
manager only for event :141); cancel :165-166 (only delete pending); x-ray I-4. Needs Snapshots.State.manager.

RT-05 (SPECIFIC, MEDIUM, SHOULD-HOLD): cancelManagerTransfer() with no pending (pendingManager already 0)
is a safe no-op: no revert, pending stays 0, manager untouched; twice == once. Evidence: NatSpec verbatim
:161-163 "No-op if no pending transfer exists (but still emits the event...)".

RT-06 (SPECIFIC, MEDIUM, EXPLORATORY): From a pranked-reachable manager M0 (set via Guardian.setManager(actorA)
first, since genesis manager is the Guardian contract which can't originate calls), M0 proposes actorB, actorB
accepts, then actorB proposes M0 back, M0 accepts → manager back at M0, pendingManager==0. Two-step transfer
is fully reversible when both parties cooperate, no residual/dust. NEEDS A BESPOKE MULTI-CALL HANDLER (spans 4
calls threading a specific value — cannot decompose into atomic per-call postconditions). Evidence: composed
from accept :151-157 + I-4; no single doc line asserts the 4-step compound claim → EXPLORATORY.

Scope excluded: initializeManager re-revert (access-control, not round-trip), setManager zero-reject (boundary
guard), unauthorized-caller ghosts (other agents), setGuardian (no natural inverse pair).

---

## AGENT 3 — State Transition Mapper: 32 properties (ST-01..ST-23, VT-01..VT-05, VS-01..VS-04)

Two doc corrections up front:
(1) proposeManager (:139-142) has NO guard on prior pendingManager — it UNCONDITIONALLY overwrites from any
prior value (0 OR a different nonzero X). So the precise rule is "only proposeManager can make pendingManager
nonzero, from anywhere", not "0→X only". Enables ST-13 (stale-proposal rejection).
(2) Guardian.setManager forwards to authenticator.setManager which CLEARS pendingManager as a side effect
(:119-123). So "a solver-set op doesn't touch pendingManager" holds for add/removeSolver but is FALSE for
setManager — flagged so the Synthesizer doesn't over-generalize.
Also: X-1 binding (manager==address(Guardian)) is bidirectionally reachable in-campaign (toGovernanceCandidate
includes address(allowListGuardian)); once lost it cannot be restored THROUGH the Guardian (it has no
accept/propose forwarder) — only a direct authenticator call restores it (ST-05, ST-23). manager CAN legally
become address(0) via direct setManager(0) only (ST-20). EIP-1967 admin slot set once in harness constructor,
never re-set in scope → de-facto campaign constant readable via StorageAccessible (ST-22/VT-04).

ST-01 (SPECIFIC, HIGH, SHOULD-HOLD): Guardian.addSolver(s) success ⇒ isSolver(s)==true, but only succeeds
while manager==address(Guardian) (else reverts inside the forward). Evidence: G-1, G-6, X-1.
ST-02 (SPECIFIC, HIGH, SHOULD-HOLD): Guardian.removeSolver(s) success ⇒ isSolver(s)==false, conditional on
manager==address(Guardian). Evidence: G-2, G-6, X-2.
ST-03 (SPECIFIC, HIGH, SHOULD-HOLD): Guardian.setManager(m!=0) success ⇒ authenticator.manager()==m AND
pendingManager()==0 (side-effect clear), conditional on manager==Guardian; m==0 rejected pre-forward (G-4).
Evidence: G-4; :112-125.
ST-04 (SPECIFIC, MEDIUM, SHOULD-HOLD): Guardian.setGuardian(g!=0) success ⇒ guardian==g and touches NOTHING
on the authenticator (no forward call at all). Strong negative postcondition. Evidence: :111-115, G-5.
ST-05 (GLOBAL, HIGH, SHOULD-HOLD): "Guardian authority" == derived condition manager()==address(Guardian);
Guardian.add/remove/setManager succeed ONLY while it holds; setGuardian exempt. Bidirectional. Evidence: X-1;
NatSpec :20,33. THE key cross-contract fact — Guardian-layer onlyTimelock/onlyGuardian is necessary but NOT
sufficient; the authenticator's onlyManager against the CURRENT manager is the real gate for 3 of 4.
ST-06 (SPECIFIC, HIGH, SHOULD-HOLD): direct addSolver(s) success ⇒ isSolver(s)==true iff effectiveCaller ==
manager() at call time (mutable — GUARDIAN_ROLE can become manager and legitimately succeed). Evidence: G-6.
ST-07 (SPECIFIC, HIGH, SHOULD-HOLD): mirror for removeSolver → isSolver(s)==false. Evidence: G-6, :187-190.
ST-08 (SPECIFIC, HIGH, SHOULD-HOLD): add/removeSolver(a) flips isSolver ONLY for a; no other probe address's
membership changes; never touches manager/pendingManager/guardian/timelock/authenticator. Frame condition.
Evidence: :176-190 single mapping write. (Probe set: 3 actors, both roles, Guardian addr.)
ST-09 (SPECIFIC, HIGH, SHOULD-HOLD): direct setManager(m) sets manager==m for ANY m INCLUDING 0 (no reject
here, I-3), and unconditionally leaves pendingManager==0. Evidence: :112-125, I-3.
ST-10 (SPECIFIC, HIGH, SHOULD-HOLD): proposeManager(m) sets pendingManager==m UNCONDITIONALLY (from 0 or a
different nonzero), manager unchanged. ONLY fn that raises pending off zero. Evidence: :139-142 (correction to
I-4 "0→X" phrasing).
ST-11 (SPECIFIC, MEDIUM, SHOULD-HOLD): cancelManagerTransfer() ⇒ pendingManager==0 (no-op-safe), never
touches manager/solvers. Evidence: :164-168.
ST-12 (SPECIFIC, HIGH, SHOULD-HOLD): acceptManagership() is the ONLY fn where manager takes the value pending
held just before; requires msg.sender==that exact prior pending (nonzero); atomically clears pending to 0.
Evidence: :151-158 (G-8,G-9), I-4. Highest-value property for typo-resistance.
ST-13 (GLOBAL, HIGH, SHOULD-HOLD): stale proposal can never be accepted — propose(X) then propose(Y!=X)
(no intervening accept) ⇒ later acceptManagership() by X must revert. Needs ghost lastProposedManager.
Evidence: :139-142, :151-158 (G-9); from ST-10 overwrite semantics. Likely hit organically (small candidate set).
ST-14 (SPECIFIC, MEDIUM, SHOULD-HOLD): paired symmetry — add then remove nets false; reverse nets true; twice
is idempotent no-revert; no effect on other addresses. Evidence: NatSpec "idempotent" both; I-5.
ST-15 (SPECIFIC, MEDIUM, SHOULD-HOLD): propose(X) then cancel() nets pending==0 with manager NEVER having
changed — X's candidacy fully discarded, no trace in manager. Evidence: :139-142, :164-168.
ST-16 (GLOBAL, HIGH, SHOULD-HOLD): manager has EXACTLY 3 writer fns: initializeManager (once), setManager,
acceptManagership. Guardian.setManager is not an independent 4th writer (it calls authenticator.setManager).
No other fn writes manager. Evidence: :72-75,112-125,151-158 (only 3 assign sites). Writer-set exactness.
ST-17 (GLOBAL, HIGH, SHOULD-HOLD): pendingManager has EXACTLY 4 writers: propose, accept, cancel, setManager
(side effect). Only propose can leave it NONZERO; accept/cancel/setManager only drive to 0. initializeManager
never touches it. Evidence: :72-75,112-125,139-142,151-158,164-168. Corrected version of I-4.
ST-18 (GLOBAL, HIGH, SHOULD-HOLD): guardian has EXACTLY 2 writers: constructor + setGuardian, both non-zero
(G-3,G-5). No other fn (either contract) writes it. Evidence: :60,79-88,111-115.
ST-19 (GLOBAL, LOW, SHOULD-HOLD): timelock & authenticator have ZERO post-construction writers (immutable).
Compiler-enforced. Evidence: :52,55 immutable; I-2.
ST-20 (SPECIFIC+GLOBAL corollary, HIGH, SHOULD-HOLD): manager can reach 0 ONLY via direct setManager(0);
never via Guardian.setManager (G-4 rejects), never via accept (G-8 needs pending!=0), never via propose+accept.
Once manager==0, onlyManager fns unreachable by every fuzzer caller; only the immutable admin (TIMELOCK_ROLE
via onlyManagerOrOwner) retains recovery. FAIL-SAFE by design. Evidence: :112-125,:151-158; I-3.
ST-21 (GLOBAL, MEDIUM, SHOULD-HOLD): cross-contract isolation — no authenticator fn writes Guardian storage;
no Guardian fn writes authenticator solvers/manager/pending EXCEPT its 3 documented forwards; setGuardian never
reaches the authenticator. Evidence: whole-file read.
ST-22 (GLOBAL, MEDIUM-HIGH, SHOULD-HOLD): EIP-1967 admin slot (via StorageAccessible.getStorageAt) stays fixed
at TIMELOCK_ROLE for the whole campaign — no in-scope reachable fn calls setAdmin. Evidence: Helper.sol:9-13
(only harness ctor sets it); GPv2EIP1967 setAdmin never called in scope. NOT compiler-enforced → worth a live
property (guards against a future PR exposing setAdmin).
ST-23 (GLOBAL, MEDIUM, EXPLORATORY): once manager!=address(Guardian), restoring it requires a DIRECT
setManager(Guardian)/propose(Guardian)+accept by current manager/admin — NEVER via the Guardian (no forwarder).
Evidence: structural (Guardian has no accept/propose forwarder); not asserted in x-ray → EXPLORATORY.

VT-01 (GLOBAL, HIGH, SHOULD-HOLD): _initialized is a one-way false→true latch; setup() already called
initializeManager once, so EVERY fuzzer call to initializeManager MUST revert "Initializable: initialized",
any caller/arg, whole campaign. extcodesize>0 so _isConstructor always false too. Evidence: Initializable
:38-55; Base :~110; :72-75.
VT-02 (GLOBAL, LOW, SHOULD-HOLD): timelock immutable == TIMELOCK_ROLE always. Compiler-guaranteed. Evidence: :55.
VT-03 (GLOBAL, LOW, SHOULD-HOLD): authenticator immutable == address(authentication) always. Evidence: :52.
VT-04 (GLOBAL, MEDIUM-HIGH, SHOULD-HOLD): EIP-1967 admin de-facto campaign-constant (see ST-22). Listed under
monotonicity as it behaves immutable-like without the keyword — highest-value member since NOT compiler-enforced.
VT-05 (informational, LOW, SHOULD-HOLD as a NEGATIVE claim): guardian/manager/pendingManager/solvers[x] are all
freely bidirectionally mutable — do NOT model any as monotonic (would false-positive on legit rotation). The only
guarantee on guardian is the persistent NON-ZERO condition (I-1), a safety invariant not a direction constraint.

VS-01 (SPECIFIC, HIGH, SHOULD-HOLD): acceptManagership success is an atomic PAIR — pendingManager==0 AND
manager==caller both hold after, never just one. Evidence: :151-158; G-8,G-9,I-4.
VS-02 (SPECIFIC, HIGH, SHOULD-HOLD): setManager(m) success is atomic pair — manager==m AND pendingManager==0
both after, regardless of m (incl 0) or prior pending. The pending-clear is unconditional-on-success. Evidence:
:112-125. (Explicitly flags that the naive "solver-op doesn't touch pending" template does NOT extend here.)
VS-03 (GLOBAL, MEDIUM, SHOULD-HOLD): "Guardian authority active" (manager==address(Guardian)) is a cross-contract
sync condition between two independently-stored vars — MUST be recomputed fresh each check, never cached in a
ghost (would drift). Design note: do NOT add a stored ghosts.guardianAuthorityActive. Evidence: X-1.
VS-04 (SPECIFIC, MEDIUM, EXPLORATORY): manager==X after a call IFF that call was acceptManagership where prior
pending was exactly X and sender==X. Forward is SHOULD-HOLD (ST-12/VS-01); the strict "only-if / no-other-path"
is inferred (setManager(sameValue) can coincidentally match) → needs a ghost tag lastCallWasAccept to
disambiguate. EXPLORATORY. Evidence: :112-125 vs :151-158.

Proposed shared vocabulary: ghosts.unauthorized*Mutation, ghosts.lastProposedManager;
State.manager/pendingManager/guardian/isSolverTarget.

---

## AGENT 4 — Adversarial Profit Maximizer: 14 properties (ADV-01..ADV-14)

Centerpieces: ADV-08 (guardian gains instant-add by becoming manager — inverts SLOW/FAST design, all calls
individually authorized, SolverAddedViaTimelock never fires) and ADV-10 (X-2 evict-liveness only conditional on
unenforced X-1). Handler coverage gap flagged: AllowListGuardianHandler only exercises correct-role and generic
asActor strangers — never GUARDIAN_ROLE attempting timelock-only fns or TIMELOCK_ROLE attempting removeSolver
(the actual named adversary). Recommends adding allowListGuardian_addSolver_asGuardian,
_setManager_asGuardian, _setGuardian_asGuardian, _removeSolver_asTimelock variants (strengthens ADV-05/ADV-08).

ADV-01 (GLOBAL, HIGH, SHOULD-HOLD): non-timelock can never cause a solver-ADD, manager handoff, or guardian
rotation through the Guardian. Ghosts: unauthorizedGuardianAdd/ManagerChange/Rotation set in *_unauthorized
handlers (only reached if the call did NOT revert). Evidence: :70 onlyTimelock (G-1); actors disjoint from role.
ADV-02 (GLOBAL, HIGH, SHOULD-HOLD): non-guardian can never cause removeSolver through the Guardian. Ghost
unauthorizedGuardianRemove. Evidence: :75 onlyGuardian (G-2).
ADV-03 (GLOBAL, HIGH, SHOULD-HOLD): on the authenticator directly, no caller != current manager can add/remove;
no caller not in {manager, admin} can setManager/propose/cancel. Check vs CURRENT manager (read before call).
Ghosts unauthorizedDirectAdd/Remove/ManagerMutation. Evidence: :80 (G-6), :90-93 (G-7).
ADV-04 (SPECIFIC, HIGH, SHOULD-HOLD): no address becomes manager via accept unless it is the EXACT most-recent
proposed address — two-step gate unbypassable, proposal not stealable by racing. Ghost nonExactAcceptSucceeded.
Evidence: :152 (G-8), :153 (G-9), I-4. THE privilege-escalation gate.
ADV-05 (SPECIFIC, HIGH, SHOULD-HOLD): cross-role — guardian can never succeed on Guardian's timelock-only fns;
timelock can never succeed on removeSolver. Compromised guardian bounded to remove-only. NEEDS the 4 new
cross-role handler variants (coverage gap above). Ghosts guardianSucceededOnTimelockOnlyFn,
timelockSucceededOnGuardianOnlyFn. Evidence: G-1/G-2; x-ray verdict.
ADV-06 (SPECIFIC, HIGH, SHOULD-HOLD): compromised guardian cannot entrench/rotate itself — guardian changes
only via msg.sender==timelock, never guardian acting alone. Ghost guardianSelfRotated. Evidence: NatSpec :57-59
("Rotatable only via the timelock so a compromised guardian cannot entrench itself"), stated outright.
ADV-07 (SPECIFIC, HIGH, SHOULD-HOLD): initializeManager can never succeed a second time (any caller/arg).
Ghost initializeManagerSucceededTwice. Evidence: Initializable :38-42; setup consumes the one call; no
selfdestruct in scope. Full-takeover if bypassable.
ADV-08 (SPECIFIC, HIGH, EXPLORATORY): guardian must never get instant undelayed add. Chain (reachable with
EXISTING handlers): proposeManager_asAdmin(GUARDIAN_ROLE) [asTimelock] → acceptManagership_asGuardian()
[asGuardian] → addSolver_asGuardian(s) [asGuardian succeeds since manager==GUARDIAN_ROLE]. Ghost
guardianBecameManagerThenInstantAdded — EXPECTED TO BE VIOLATED (it's a real reachable inversion, no require
broken). Evidence: X-1 "on-chain: No"; NatSpec :45-46 reasons about the guardian-self-service variant and blocks
THAT (Guardian.setManager is onlyTimelock) but the direct path is open; x-ray claims adds are always
monitorable/24h-gated — false once manager moves off the Guardian. THE flagship finding.
ADV-09 (SPECIFIC, HIGH, SHOULD-HOLD): while X-1 holds (manager==address(Guardian)), guardian's instant
removeSolver can never be blocked/delayed/reverted by anything the timelock does — inline assert !isSolver
after. Evidence: :121-124 (removeSolver has no timelock reference; G-2), X-2. Liveness.
ADV-10 (SPECIFIC, HIGH, EXPLORATORY): X-2's "frozen timelock never blocks eviction" is NOT unconditional —
the timelock's own Guardian.setManager(x!=Guardian) moves manager away, after which guardian removeSolver
reverts. Ghosts timelockBrokeEvictBinding, evictBlockedByBrokenBinding — EXPECTED VIOLATED. Evidence: X-2 vs
X-1 tension. Human question: should Guardian.setManager refuse to move manager off itself, or assert X-1?
ADV-11 (SPECIFIC, HIGH, EXPLORATORY): direct setManager(0) bricks BOTH the onlyManager path AND the Guardian
forward path (Guardian no longer manager) — total temporary DoS of add AND remove, single call. Ghosts
managerEverZeroed, bothPathsBrickedByZeroManager. Evidence: :112-125 no zero check vs Guardian :104; I-3. The
explicit lead the context asked to explore.
ADV-12 (SPECIFIC, HIGH, SHOULD-HOLD): no matter the manager value (incl 0), the EIP-1967 admin (TIMELOCK_ROLE)
can always setManager to recover — onlyManagerOrOwner admin branch independent of manager; admin slot never
rewritten in scope. Brick in ADV-11 is never PERMANENT. Ghost adminRescueEverFailed (must stay false).
Evidence: :89-95; GPv2EIP1967 setAdmin never called in scope. Liveness counterpart to ADV-11.
ADV-13 (SPECIFIC, MEDIUM, SHOULD-HOLD): two-step path is zero-brick-proof — accept can never set manager to 0
(G-8 requires pending!=0 before the assign), unlike one-step setManager. Ghost acceptManagershipEverZeroedManager.
Evidence: :152 (G-8). Shows which rail is risky (one-step) vs safe (two-step).
ADV-14 (SPECIFIC, HIGH, SHOULD-HOLD): no non-{manager,admin} caller can set/overwrite/clear pendingManager —
attacker cannot squat/redirect/grief an in-flight proposal. Ghost unauthorizedPendingManagerMutation. Evidence:
:139-142 (G-7), :164-168 (G-7). Distinct attack shape from ADV-04 (griefing vs escalation).

Closing: no permanent unrecoverable brick reachable purely through these two contracts (ADV-12 escape hatch).
ADV-08 and ADV-10 are the top human-review items.

---

## AGENT 5 — Protocol-Type Specialist (GOVERNANCE): 10 properties (GOV-01..GOV-10)

Confirmed via grep: no block.timestamp/block.number/minDelay in either audited contract; GPv2EIP1967.setAdmin
called nowhere but the test harness ctor; _initialized has exactly one write site (always true).

GOV-01 (GLOBAL, HIGH, SHOULD-HOLD): the EIP-1967 admin's onlyManagerOrOwner authority over
setManager/propose/cancel is never revoked by a manager handoff — admin can always call these regardless of who
holds manager, across arbitrarily many rotations. Live probe via cancelManagerTransfer as _currentAdmin().
Evidence: :89-95 (admin disjunct independent of manager), G-7. Asserts PERSISTENCE across a sequence (vs Agent 4's
single-call check).
GOV-02 (GLOBAL, MEDIUM, SHOULD-HOLD): the set of addresses that can ever succeed on the 3 onlyManagerOrOwner fns
is EXACTLY {manager(), admin} — never a third (not guardian, not an arbitrary actor, not a stale pendingManager).
Evidence: same 2-clause OR, no other disjunct. Negative-space complement to GOV-01.
GOV-03 (GLOBAL, MEDIUM, SHOULD-HOLD): EIP-1967 admin slot is write-never in scope → _currentAdmin() returns the
SAME value after every handler call, whole campaign. Ghost initialAdmin set once in setup(). Evidence: only setAdmin
call site repo-wide is Helper.sol:11. (Overlaps ST-22/VT-04 — merge.)
GOV-04 (GLOBAL, MEDIUM, EXPLORATORY): harness sets admin==timelock (both TIMELOCK_ROLE) per prod intent
(AllowListGuardian.sol:33-35), but NOTHING enforces _currentAdmin()==allowListGuardian.timelock() — a SECOND,
previously-uncatalogued instance of the X-1 unenforced-binding pattern (admin↔timelock, distinct from the
manager↔Guardian binding x-ray names). Evidence: X-1 by analogy; no code cross-references them. Genuinely new.
GOV-05 (SPECIFIC, HIGH, SHOULD-HOLD): Guardian.add/setManager/setGuardian succeed instantly for msg.sender==
timelock with NO on-chain time/block check — a back-to-back pair in the SAME block both succeed. The ">=24h"
delay is enforced entirely by the external OZ TimelockController at the timelock address, NEVER by these contracts.
Evidence: grep — zero block.timestamp/number/minDelay refs; modifiers are pure msg.sender equality. The G-05
"execution only after delay" analog: makes explicit the delay is documented-but-off-contract.
GOV-06 (GLOBAL, HIGH, SHOULD-HOLD): while pendingManager==X (nonzero), X gains NO privilege other than calling
acceptManagership() — X cannot add/remove/setManager/propose/cancel merely by being pending (those gate on
current manager/admin; pending is read nowhere in onlyManager/onlyManagerOrOwner). Evidence: pending referenced
only at :41,119-123,139-141,152-157,165-167 — never in the modifiers :79-82/:89-95.
GOV-07 (SPECIFIC, LOW, SHOULD-HOLD): for an authorized caller, cancelManagerTransfer() never reverts (even when
pending==0, documented no-op); proposeManager(x) never reverts for ANY x (incl 0, self, current manager/admin) —
zero input validation, unlike Guardian.setManager which rejects 0 (see GOV-08). Evidence: :139-142, :164-168
unconditional bodies. Liveness.
GOV-08 (GLOBAL, MEDIUM, SHOULD-HOLD): manager can become 0 ONLY via the single-step rail (setManager(0)/I-3, or
genesis initializeManager(0)) — NEVER via propose→accept (accept requires pending!=0 before assigning). So
proposeManager(0) is inert; no one can "accept a zero proposal" to brick the role. Two-step rail strictly safer
than single-step re: zero-bricking. Ghost managerWasZeroedByAcceptManagership (must stay false). Evidence: G-8
(:152), I-3. Composite of I-3+I-4 neither states alone.
GOV-09 (SPECIFIC, HIGH, EXPLORATORY): X-1 unenforced; once broken via authorized handoff, exactly 3 of Guardian's
4 fns become permanently-reverting dead code (add/remove/setManager all forward and fail one level deeper at the
authenticator's onlyManager/onlyManagerOrOwner since msg.sender==address(Guardian) no longer matches manager/admin)
— even though Guardian-level onlyTimelock/onlyGuardian still passes. Guardian CANNOT self-heal via its own
setManager (recovery needs a direct authentication.setManager). setGuardian (no forward) is UNAFFECTED. The new
manager (even GUARDIAN_ROLE or a plain actor) gains raw INSTANT add/remove on the authenticator — contradicts the
NatSpec fail-safe claim ("guardian's instant removeSolver keeps working"/"capability can only be reduced"), which
implicitly assumes X-1 holds. Multi-step (authorized handoff, then probe). Evidence: chain of X-1 + G-6 + G-2 +
G-1 + NatSpec :39-49; composite derivation → EXPLORATORY. Flagship composability finding (overlaps ADV-08/09/10 —
merge into that cluster).
GOV-10 (GLOBAL, LOW, SHOULD-HOLD): Initializable._initialized written true exactly once, never false anywhere —
no de-init entry point. After setup()'s single call, initializeManager reverts "Initializable: initialized" for
every caller/arg for an arbitrarily long campaign. Evidence: Initializable :28,:40,:47 (single write);
GPv2AllowListAuthentication never references _initialized. (Overlaps VT-01/ADV-07 — merge.)

Scope excluded: generic only-X pass/fail tables (Agent 4), full pending transition enumeration + idempotency
(Agent 3/1), economic (none), raw guardian!=0 / immutability (I-1/I-2, trivially covered).
