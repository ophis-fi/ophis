# INVARIANT_CONTEXT — Ophis solver-allowlist governance layer

## Protocol type & value model
Access-control / governance wrapper. **These two contracts hold NO funds and encode
NO economic parameters** (x-ray.md §4 Economic: None). There are **no aggregate/total
variables, no conversion/preview functions, and no rounding math**. The value-at-risk is
*settlement capability*: an allowlisted solver can dispatch settlements against the
(out-of-scope, vendored) GPv2Settlement. So the ONLY security property that matters is
**who can mutate the solver set and the manager/guardian roles**.

Conservation-Auditor and Round-Trip/Rounding-Analyst: expect to find little or nothing
here — that is correct. Emit only what genuinely applies (e.g. "solver-set membership is
binary/idempotent" is arguably a degenerate conservation fact). Do NOT invent economic
invariants that do not exist.

## In-scope contracts (read the source — paths in FILE_PATHS)

### AllowListGuardian.sol (Ophis-authored governance wrapper, #442)
Splits the authenticator `manager()` role into a SLOW timelocked path and a FAST guardian path.
- **Immutables** (set once in constructor, never writable after): `authenticator`
  (IGPv2AllowListAuthentication), `timelock` (address).
- **Mutable state**: `guardian` (address).
- Constructor: rejects zero for authenticator/timelock/guardian ("Guardian: zero address");
  emits `GuardianChanged(guardian_, address(0))`.
- `addSolver(solver)` — `onlyTimelock` — forwards → `authenticator.addSolver(solver)`.
- `setManager(newManager)` — `onlyTimelock` — **rejects address(0)** ("Guardian: zero manager")
  — forwards → `authenticator.setManager(newManager)`.
- `setGuardian(newGuardian)` — `onlyTimelock` — **rejects address(0)** ("Guardian: zero guardian")
  — sets `guardian = newGuardian`.
- `removeSolver(solver)` — `onlyGuardian` — instant — forwards → `authenticator.removeSolver(solver)`.
- Modifiers: `onlyTimelock` = `require(msg.sender == timelock)`, `onlyGuardian` = `require(msg.sender == guardian)`.

### GPv2AllowListAuthentication.sol (vendored CoW core + Ophis MED-1 two-step hardening)
- **State**: `manager` (address public), `solvers` (mapping(address=>bool) **private**;
  read only via `isSolver(address) view`), `pendingManager` (address public). Plus inherited
  Initializable `_initialized`/`_initializing`.
- `initializeManager(m)` — `initializer` (callable exactly once) — sets `manager = m`.
- Modifiers: `onlyManager` = `require(manager == msg.sender)`;
  `onlyManagerOrOwner` = `require(manager == msg.sender || GPv2EIP1967.getAdmin() == msg.sender)`
  (proxy admin via EIP-1967 admin slot).
- `setManager(m)` — `onlyManagerOrOwner` — **instant** single-step; sets `manager = m` and,
  if `pendingManager != 0`, clears it (emits ManagerTransferCancelled). **NO zero-address
  check at this layer** (unlike the Guardian wrapper — see I-3 caveat below).
- `proposeManager(m)` — `onlyManagerOrOwner` — sets `pendingManager = m` (two-step step 1/2, MED-1).
- `acceptManagership()` — **no modifier**, but internally
  `require(pendingManager != address(0))` + `require(msg.sender == pendingManager)`; on success
  `manager = pendingManager`, `delete pendingManager` (two-step step 2/2).
- `cancelManagerTransfer()` — `onlyManagerOrOwner` — `delete pendingManager`.
- `addSolver(s)` — `onlyManager` — `solvers[s] = true` (idempotent).
- `removeSolver(s)` — `onlyManager` — `solvers[s] = false` (idempotent).
- `isSolver(s)` — view — returns `solvers[s]`.

## Deployment topology used by the fuzz harness (test/fizz/Base.sol)
1. `authentication` = new GPv2AllowListAuthenticationHarness(TIMELOCK_ROLE) — the harness sets
   the EIP-1967 proxy-**admin** slot to `TIMELOCK_ROLE` in its constructor (emulates the proxy).
2. `allowListGuardian` = new AllowListGuardian(address(authentication), TIMELOCK_ROLE, GUARDIAN_ROLE).
3. `authentication.initializeManager(address(allowListGuardian))` — so **`manager == Guardian`
   from transaction 0** (the X-1 binding, i.e. steady-state production topology).
- `TIMELOCK_ROLE = address(0x1111)` plays BOTH the Guardian's immutable `timelock` AND the
  authenticator's EIP-1967 proxy **admin** (matching prod intent: same timelock for both).
- `GUARDIAN_ROLE = address(0x2222)` is the Guardian's fast-evict Safe.
- The 3 generic `actors` are `Actor` contract instances; **none is ever TIMELOCK_ROLE or
  GUARDIAN_ROLE** (the pools are kept disjoint), so an `asActor` call is always an
  "unauthorized stranger" relative to every privileged function.

## Handler surface available to the fuzzer (test/fizz/handlers/*)
- **AllowListGuardianHandler**: correct-role paths `addSolver`(asTimelock), `removeSolver`
  (asGuardian), `setManager`(asTimelock), `setGuardian`(asTimelock via `_secondary` dispatcher);
  adversarial wrong-role variants `*_unauthorized`(asActor); boundary stress
  `setManager_zero`, `setManager_self`.
- **GPv2AllowListAuthenticationHandler** (calls the authenticator DIRECTLY, bypassing the
  Guardian): `addSolver`/`removeSolver`/`proposeManager`/`acceptManagership`/`setManager` each
  with asActor + asTimelock(=admin) + asGuardian caller variants; `setManager_zero` stress;
  `cancelManagerTransfer` + `initializeManager` via `_secondary` dispatcher.
- Address parameters are mapped through `toActor(...)` (→ one of 3 actors) or
  `toGovernanceCandidate(...)` (→ actor | Guardian | TIMELOCK_ROLE | GUARDIAN_ROLE) in the
  clamped layer; raw addresses reachable via unclamped variants.

## CRITICAL property-authoring guidance for THIS protocol
- `manager` is **mutable**: `setManager`/`acceptManagership` can legitimately hand the manager
  role to an actor or role at runtime. So "only manager may add/remove solvers" must be checked
  against the **CURRENT** `authentication.manager()`, NOT a fixed constant. The battle-tested
  formulation (see existing echidna harness) is a **ghost that records whether any solver-set
  or manager mutation EVER landed from an unauthorized caller** — a global property that the
  ghost stays false. Prefer ghost-tracked "unauthorized mutation never happened" properties
  over naive "state never changed" (which is false — authorized mutation is expected).
- The `solvers` mapping is **private**; only `isSolver(addr)` exposes it. Properties can read
  membership of the actor addresses / role addresses via `isSolver`.
- Distinguish the two `setManager`s: the **Guardian** wrapper rejects address(0); the
  **authenticator** does NOT (an authorized manager/admin CAN zero it directly — I-3 caveat).

## Candidate invariants (from x-ray/invariants.md + domain notes) — starting point, refine/expand
- Only the timelock can add a solver or change manager/guardian **through the Guardian**
  (G-1/G-6). [SHOULD-HOLD — enforced by onlyTimelock + onlyManager require guards, cite code]
- Only the guardian can remove a solver **through the Guardian** (G-2). [SHOULD-HOLD]
- `guardian != address(0)` always (I-1: constructor + setGuardian both reject 0). [SHOULD-HOLD]
- `timelock` and `authenticator` are immutable post-deploy (I-2). [SHOULD-HOLD — `immutable` keyword]
- Guardian.`setManager` never forwards address(0) to the authenticator (I-3, G-4). [SHOULD-HOLD]
- Two-step transfer completes only for the EXACT proposed address (I-4, G-8+G-9): no non-proposed
  address can become manager via propose→accept. [SHOULD-HOLD]
- `pendingManager` state machine: 0→X only via proposeManager; X→0 via acceptManagership
  (sets manager=X), cancelManagerTransfer, or setManager. [SHOULD-HOLD]
- Solver-set membership changes ONLY via an authorized (manager-gated) path (I-5). [SHOULD-HOLD]
- `addSolver`/`removeSolver` are idempotent (I-5). [SHOULD-HOLD]
- `initializeManager` can never succeed again post-deployment (Initializable). [SHOULD-HOLD]
- After `acceptManagership`, `pendingManager == address(0)` and `manager == the accepting caller`.
- `setManager`/`acceptManagership`/`initializeManager` are the ONLY writers of `manager`.

## Extracted signals
- AGGREGATE_VARIABLES: **none**.
- PAIRED_OPERATIONS: addSolver/removeSolver; proposeManager/acceptManagership (cancelManagerTransfer = the cancel edge).
- CONVERSION_FUNCTIONS: **none**.
- ACCESS_CONTROL: onlyManager, onlyManagerOrOwner, onlyTimelock, onlyGuardian, initializer, EIP-1967 getAdmin().

## Existing coverage to COMPLEMENT (do not duplicate wholesale)
`contracts/echidna/E2EAllowList.sol` and `E2EAllowListGuardian.sol` already fuzz the pure
"no unauthorized sender can mutate" property with roles OUTSIDE the sender set. This fizz suite
deliberately ALSO exercises the correct-role paths in the same campaign, so it can assert
positive postconditions (add really adds, two-step really transfers) and the "unauthorized
mutation never landed" ghost property while both authorized and unauthorized calls are live.
