// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with AllowListGuardian
///
/// Caller-context legend (see Base.sol):
///   asTimelock -> TIMELOCK_ROLE, the only caller `addSolver`/`setManager`/
///                 `setGuardian` should ever accept.
///   asGuardian -> GUARDIAN_ROLE, the only caller `removeSolver` should ever
///                 accept.
///   asActor    -> one of the 3 generic actors, none of which is ever
///                 TIMELOCK_ROLE or GUARDIAN_ROLE (Base.sol keeps the pools
///                 disjoint) -- i.e. a genuine "unauthorized stranger" for
///                 every function in this handler. Kept as a live fuzz
///                 target (not asserted here) so Step 9 properties can
///                 ghost-track whether an unauthorized call ever slips
///                 through.
abstract contract AllowListGuardianHandler is Properties {

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function allowListGuardian_addSolver_clamped(address solver) public {
        // Bias toward known actors so a later removeSolver has a real
        // chance of targeting a previously-added solver.
        solver = toActor(solver);
        allowListGuardian_addSolver(solver);
    }

    function allowListGuardian_removeSolver_clamped(address solver) public {
        solver = toActor(solver);
        allowListGuardian_removeSolver(solver);
    }

    function allowListGuardian_setManager_clamped(address newManager) public {
        // Bias toward the governance-meaningful candidates (actors, the
        // Guardian itself, TIMELOCK_ROLE, GUARDIAN_ROLE) -- see
        // Base.toGovernanceCandidate for why.
        newManager = toGovernanceCandidate(newManager);
        allowListGuardian_setManager(newManager);
    }

    /// Boundary-value stress: address(0) is rejected by the Guardian's own
    /// guard ("Guardian: zero manager"). Always hit it directly rather than
    /// hoping a random address lands on zero.
    function allowListGuardian_setManager_zero() public {
        allowListGuardian_setManager(address(0));
    }

    /// Boundary-value stress: re-propose the Guardian as its own manager
    /// target (no-op-ish handoff back to itself).
    function allowListGuardian_setManager_self() public {
        allowListGuardian_setManager(address(allowListGuardian));
    }

    function allowListGuardian_secondary(uint8 selector, address arg0) public {
        selector = uint8(selector % 2);
        if (selector == 0) _allowListGuardian_setGuardian(toGovernanceCandidate(arg0));
        else _allowListGuardian_setGuardian_unauthorized(arg0);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    // ─── Correct-role paths ───────────────────────────────────────────

    function allowListGuardian_addSolver(address solver) public asTimelock {
        ghosts.lastOp = GUARD_ADD;
        currentTarget = solver;
        snapshotBefore();
        allowListGuardian.addSolver(solver);
        snapshotAfter();
        property_guardianAddSolverPostcondition(solver);
        property_solverSetAbsorbingAndIdempotent(solver, true);
        property_solverOpFrameCondition();
    }

    function allowListGuardian_removeSolver(address solver) public asGuardian {
        ghosts.lastOp = GUARD_REMOVE;
        currentTarget = solver;
        bool x1 = authentication.manager() == address(allowListGuardian);
        snapshotBefore();
        try allowListGuardian.removeSolver(solver) {
            snapshotAfter();
            property_guardianRemoveSolverPostcondition(solver);
            property_solverSetAbsorbingAndIdempotent(solver, false);
            property_solverOpFrameCondition();
            if (x1) {
                property_evictLivenessWhileX1Held(solver);
            }
        } catch {
            // A revert here while X-1 was already broken by an earlier
            // timelock setManager is the SP-23 lead; manager==0 is the
            // SP-24 system-wide-brick lead (onlyManager fails identically
            // for the add-path forward too, at this same manager value).
            if (ghosts.timelockBrokeEvictBinding && !x1) {
                ghosts.evictBlockedByBrokenBinding = true;
            }
            if (authentication.manager() == address(0)) {
                ghosts.bothPathsBrickedByZeroManager = true;
            }
            property_evictLivenessLostIfX1Broken();
            property_x1BrokenDeadCodeAndRawPower();
        }
    }

    function allowListGuardian_setManager(address newManager) public asTimelock {
        ghosts.lastOp = GUARD_SETMGR;
        bool x1HeldBefore = authentication.manager() == address(allowListGuardian);
        snapshotBefore();
        allowListGuardian.setManager(newManager);
        snapshotAfter();
        if (x1HeldBefore && newManager != address(allowListGuardian)) {
            ghosts.timelockBrokeEvictBinding = true;
        }
        property_guardianSetManagerPostcondition(newManager);
        property_evictLivenessLostIfX1Broken();
        property_x1BrokenDeadCodeAndRawPower();
    }

    function _allowListGuardian_setGuardian(address newGuardian) internal asTimelock {
        ghosts.lastOp = GUARD_SETGUARD;
        snapshotBefore();
        allowListGuardian.setGuardian(newGuardian);
        snapshotAfter();
        property_guardianSetGuardianTouchesNoAuth(newGuardian);
        property_guardianCannotSelfEntrench();
    }

    // ─── Adversarial (wrong-role) paths ────────────────────────────────
    // Wrapped in try/catch: a revert here is the expected, healthy outcome.
    // If the call instead *succeeds*, that is the access-control bypass
    // Step 9's properties are meant to catch via ghost tracking (mirrors
    // contracts/echidna/E2EAllowListGuardian.sol's "no Echidna sender is the
    // timelock/guardian" model, but exercised alongside the correct-role
    // paths above in the same campaign).

    function allowListGuardian_addSolver_unauthorized(address solver) public asActor {
        ghosts.lastOp = GUARD_ADD;
        try allowListGuardian.addSolver(solver) {
            ghosts.unauthorizedGuardianAdd = true;
        } catch {}
    }

    function allowListGuardian_removeSolver_unauthorized(address solver) public asActor {
        ghosts.lastOp = GUARD_REMOVE;
        // `guardian` is MUTABLE: setGuardian (onlyTimelock) can legitimately
        // rotate the guardian role ONTO an actor. When that has happened, this
        // actor IS the current guardian and its removeSolver is authorized, so
        // only flag success when the caller is genuinely NOT the current
        // guardian at call time (check the live role, not a fixed address).
        bool wasGuardian = allowListGuardian.guardian() == actor;
        try allowListGuardian.removeSolver(solver) {
            if (!wasGuardian) ghosts.unauthorizedGuardianRemove = true;
        } catch {}
    }

    function allowListGuardian_setManager_unauthorized(address newManager) public asActor {
        ghosts.lastOp = GUARD_SETMGR;
        try allowListGuardian.setManager(newManager) {
            ghosts.unauthorizedGuardianManagerChange = true;
        } catch {}
    }

    function _allowListGuardian_setGuardian_unauthorized(address newGuardian) internal asActor {
        ghosts.lastOp = GUARD_SETGUARD;
        address guardianBefore = allowListGuardian.guardian();
        try allowListGuardian.setGuardian(newGuardian) {
            ghosts.unauthorizedGuardianRotation = true;
            if (allowListGuardian.guardian() != guardianBefore) {
                ghosts.guardianSelfRotated = true;
            }
        } catch {}
    }

    // ─── Cross-role probes (SP-17 / SP-18 / SP-20) ─────────────────────
    // Deliberately call the Guardian's fns with the OTHER privileged role
    // (guardian trying timelock-only fns, timelock trying the guardian-only
    // removeSolver) -- these should always revert. A non-revert is the
    // cross-role-rejection bypass SP-17 exists to catch.

    function allowListGuardian_addSolver_asGuardian(address solver) public asGuardian {
        ghosts.lastOp = GUARD_ADD;
        try allowListGuardian.addSolver(solver) {
            ghosts.guardianSucceededOnTimelockOnlyFn = true;
        } catch {}
        property_crossRoleRejection();
    }

    function allowListGuardian_setManager_asGuardian(address newManager) public asGuardian {
        ghosts.lastOp = GUARD_SETMGR;
        try allowListGuardian.setManager(newManager) {
            ghosts.guardianSucceededOnTimelockOnlyFn = true;
        } catch {}
        property_crossRoleRejection();
    }

    function allowListGuardian_setGuardian_asGuardian(address newGuardian) public asGuardian {
        ghosts.lastOp = GUARD_SETGUARD;
        address guardianBefore = allowListGuardian.guardian();
        try allowListGuardian.setGuardian(newGuardian) {
            ghosts.guardianSucceededOnTimelockOnlyFn = true;
            if (allowListGuardian.guardian() != guardianBefore) {
                ghosts.guardianSelfRotated = true;
            }
        } catch {}
        property_crossRoleRejection();
        property_guardianCannotSelfEntrench();
    }

    function allowListGuardian_removeSolver_asTimelock(address solver) public asTimelock {
        ghosts.lastOp = GUARD_REMOVE;
        // `guardian` is MUTABLE: setGuardian (onlyTimelock) can legitimately
        // rotate the guardian role ONTO TIMELOCK_ROLE itself. When that has
        // happened the timelock IS the current guardian and its removeSolver is
        // authorized -- only flag success when TIMELOCK_ROLE is genuinely NOT
        // the current guardian (check the live role, not a fixed address).
        bool timelockIsGuardian = allowListGuardian.guardian() == TIMELOCK_ROLE;
        try allowListGuardian.removeSolver(solver) {
            if (!timelockIsGuardian) ghosts.timelockSucceededOnGuardianOnlyFn = true;
        } catch {}
        property_crossRoleRejection();
    }

    /// SP-20: two timelock-authorized addSolver calls in the SAME block (no
    /// vm.roll/vm.warp between) -- both must succeed since neither contract
    /// references block.timestamp/block.number/minDelay anywhere.
    function allowListGuardian_addSolver_backToBack(address solverA, address solverB) public asTimelock {
        ghosts.lastOp = GUARD_ADD;
        uint256 blockBefore = block.number;
        allowListGuardian.addSolver(solverA);
        allowListGuardian.addSolver(solverB);
        property_noOnChainDelayEnforced(solverA, solverB, blockBefore);
    }
}
