// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with GPv2AllowListAuthentication, called
/// directly (bypassing AllowListGuardian). Reachable from tx #0 for
/// `onlyManagerOrOwner` functions via the TIMELOCK_ROLE admin path (G-7);
/// reachable for `onlyManager` functions only once `manager` has been handed
/// off away from the Guardian to a plain actor/role (see
/// AllowListGuardianHandler.allowListGuardian_setManager*).
///
/// Caller-context legend (see Base.sol):
///   asActor    -> whichever of the 3 actors is `actor` right now. Succeeds
///                 only if that actor happens to currently be `manager`;
///                 otherwise a normal (harmless) revert. This single
///                 modifier naturally covers both the positive and the
///                 access-control-denial path because `manager` is mutable.
///   asTimelock -> TIMELOCK_ROLE, which is ALSO the EIP-1967 proxy admin in
///                 this harness (Base.sol). Exercises the
///                 `onlyManagerOrOwner` admin branch (G-7) independent of
///                 whoever the current manager is.
///   asGuardian -> GUARDIAN_ROLE. Only meaningful once `manager` or
///                 `pendingManager` has been handed off to GUARDIAN_ROLE
///                 directly (bypassing the AllowListGuardian contract).
abstract contract GPv2AllowListAuthenticationHandler is Properties {

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function gPv2AllowListAuthentication_addSolver_clamped(uint256 callerSeed, address solver) public {
        solver = toActor(solver);
        uint256 n = callerSeed % 3;
        if (n == 0) gPv2AllowListAuthentication_addSolver(solver);
        else if (n == 1) gPv2AllowListAuthentication_addSolver_asTimelock(solver);
        else gPv2AllowListAuthentication_addSolver_asGuardian(solver);
    }

    function gPv2AllowListAuthentication_removeSolver_clamped(uint256 callerSeed, address solver) public {
        solver = toActor(solver);
        uint256 n = callerSeed % 3;
        if (n == 0) gPv2AllowListAuthentication_removeSolver(solver);
        else if (n == 1) gPv2AllowListAuthentication_removeSolver_asTimelock(solver);
        else gPv2AllowListAuthentication_removeSolver_asGuardian(solver);
    }

    function gPv2AllowListAuthentication_proposeManager_clamped(uint256 callerSeed, address manager_) public {
        manager_ = toGovernanceCandidate(manager_);
        if (callerSeed % 2 == 0) gPv2AllowListAuthentication_proposeManager(manager_);
        else gPv2AllowListAuthentication_proposeManager_asAdmin(manager_);
    }

    function gPv2AllowListAuthentication_acceptManagership_clamped(uint256 callerSeed) public {
        uint256 n = callerSeed % 3;
        if (n == 0) gPv2AllowListAuthentication_acceptManagership();
        else if (n == 1) gPv2AllowListAuthentication_acceptManagership_asTimelock();
        else gPv2AllowListAuthentication_acceptManagership_asGuardian();
    }

    function gPv2AllowListAuthentication_setManager_clamped(uint256 callerSeed, address manager_) public {
        manager_ = toGovernanceCandidate(manager_);
        if (callerSeed % 2 == 0) gPv2AllowListAuthentication_setManager(manager_);
        else gPv2AllowListAuthentication_setManager_asAdmin(manager_);
    }

    /// Boundary-value stress: GPv2AllowListAuthentication.setManager has NO
    /// zero-address check at this layer (I-3 caveat in x-ray/invariants.md --
    /// unlike AllowListGuardian.setManager, which does reject 0). Always hit
    /// this directly via the guaranteed-valid admin path instead of hoping a
    /// random address lands on exactly address(0).
    function gPv2AllowListAuthentication_setManager_zero() public asTimelock {
        ghosts.lastOp = DIR_SETMGR;
        ghosts.lastCallWasAccept = false;
        snapshotBefore();
        authentication.setManager(address(0));
        snapshotAfter();
        ghosts.managerEverZeroed = true;
        property_directSetManagerAtomicPair(address(0));
        property_zeroManagerBricksBothPaths();
    }

    function gPv2AllowListAuthentication_secondary(uint8 selector, address arg0) public {
        selector = uint8(selector % 3);
        if (selector == 0) _gPv2AllowListAuthentication_cancelManagerTransfer();
        else if (selector == 1) _gPv2AllowListAuthentication_cancelManagerTransfer_asAdmin();
        else _gPv2AllowListAuthentication_initializeManager(arg0);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function gPv2AllowListAuthentication_addSolver(address solver) public asActor {
        ghosts.lastOp = DIR_ADD;
        currentTarget = solver;
        bool wasAuthorized = authentication.manager() == actor;
        snapshotBefore();
        try authentication.addSolver(solver) {
            snapshotAfter();
            if (!wasAuthorized) {
                ghosts.unauthorizedDirectAdd = true;
            } else {
                property_directAddSolverIffManager(solver, actor);
            }
            property_solverSetAbsorbingAndIdempotent(solver, true);
            property_solverOpFrameCondition();
        } catch {}
    }

    function gPv2AllowListAuthentication_addSolver_asTimelock(address solver) public asTimelock {
        ghosts.lastOp = DIR_ADD;
        currentTarget = solver;
        snapshotBefore();
        authentication.addSolver(solver);
        snapshotAfter();
        property_directAddSolverIffManager(solver, TIMELOCK_ROLE);
        property_solverSetAbsorbingAndIdempotent(solver, true);
        property_solverOpFrameCondition();
    }

    function gPv2AllowListAuthentication_addSolver_asGuardian(address solver) public asGuardian {
        ghosts.lastOp = DIR_ADD;
        currentTarget = solver;
        snapshotBefore();
        authentication.addSolver(solver);
        snapshotAfter();
        // SP-21 [EXPECTED-VIOLATED lead]: GUARDIAN_ROLE became manager (via
        // the direct propose/accept or setManager path) and can now
        // instant-add with no timelock delay -- the SLOW/FAST inversion.
        if (authentication.manager() == GUARDIAN_ROLE && authentication.isSolver(solver)) {
            ghosts.guardianBecameManagerThenInstantAdded = true;
        }
        property_directAddSolverIffManager(solver, GUARDIAN_ROLE);
        property_solverSetAbsorbingAndIdempotent(solver, true);
        property_solverOpFrameCondition();
        property_guardianNeverGetsInstantAdd();
        property_x1BrokenDeadCodeAndRawPower();
    }

    function gPv2AllowListAuthentication_removeSolver(address solver) public asActor {
        ghosts.lastOp = DIR_REMOVE;
        currentTarget = solver;
        bool wasAuthorized = authentication.manager() == actor;
        snapshotBefore();
        try authentication.removeSolver(solver) {
            snapshotAfter();
            if (!wasAuthorized) {
                ghosts.unauthorizedDirectRemove = true;
            } else {
                property_directRemoveSolverIffManager(solver, actor);
            }
            property_solverSetAbsorbingAndIdempotent(solver, false);
            property_solverOpFrameCondition();
        } catch {}
    }

    function gPv2AllowListAuthentication_removeSolver_asTimelock(address solver) public asTimelock {
        ghosts.lastOp = DIR_REMOVE;
        currentTarget = solver;
        snapshotBefore();
        authentication.removeSolver(solver);
        snapshotAfter();
        property_directRemoveSolverIffManager(solver, TIMELOCK_ROLE);
        property_solverSetAbsorbingAndIdempotent(solver, false);
        property_solverOpFrameCondition();
    }

    function gPv2AllowListAuthentication_removeSolver_asGuardian(address solver) public asGuardian {
        ghosts.lastOp = DIR_REMOVE;
        currentTarget = solver;
        snapshotBefore();
        authentication.removeSolver(solver);
        snapshotAfter();
        property_directRemoveSolverIffManager(solver, GUARDIAN_ROLE);
        property_solverSetAbsorbingAndIdempotent(solver, false);
        property_solverOpFrameCondition();
    }

    function gPv2AllowListAuthentication_proposeManager(address manager_) public asActor {
        ghosts.lastOp = DIR_PROPOSE;
        ghosts.lastCallWasAccept = false;
        bool wasAuthorized = authentication.manager() == actor;
        snapshotBefore();
        try authentication.proposeManager(manager_) {
            snapshotAfter();
            if (!wasAuthorized) {
                ghosts.unauthorizedDirectManagerMutation = true;
                if (authentication.pendingManager() != stateBefore.pendingManager) {
                    ghosts.unauthorizedPendingManagerMutation = true;
                }
            } else {
                ghosts.lastProposedManager = manager_;
                property_proposeManagerUnconditional(manager_);
            }
            property_pendingManagerSlotProtected();
        } catch {}
    }

    function gPv2AllowListAuthentication_proposeManager_asAdmin(address manager_) public asTimelock {
        ghosts.lastOp = DIR_PROPOSE;
        ghosts.lastCallWasAccept = false;
        snapshotBefore();
        authentication.proposeManager(manager_);
        snapshotAfter();
        ghosts.lastProposedManager = manager_;
        property_proposeManagerUnconditional(manager_);
    }

    function gPv2AllowListAuthentication_acceptManagership() public asActor {
        ghosts.lastOp = DIR_ACCEPT;
        address pendingBefore = authentication.pendingManager();
        snapshotBefore();
        try authentication.acceptManagership() {
            snapshotAfter();
            ghosts.lastCallWasAccept = true;
            if (actor != pendingBefore) {
                ghosts.nonExactAcceptSucceeded = true;
            }
            if (authentication.manager() == address(0)) {
                ghosts.acceptManagershipEverZeroedManager = true;
            }
            property_acceptManagershipAtomicPair(pendingBefore);
            property_managerPromotionOnlyViaAccept();
            property_acceptNeverZerosManager();
        } catch {}
    }

    function gPv2AllowListAuthentication_acceptManagership_asTimelock() public asTimelock {
        ghosts.lastOp = DIR_ACCEPT;
        address pendingBefore = authentication.pendingManager();
        snapshotBefore();
        try authentication.acceptManagership() {
            snapshotAfter();
            ghosts.lastCallWasAccept = true;
            if (TIMELOCK_ROLE != pendingBefore) {
                ghosts.nonExactAcceptSucceeded = true;
            }
            if (authentication.manager() == address(0)) {
                ghosts.acceptManagershipEverZeroedManager = true;
            }
            property_acceptManagershipAtomicPair(pendingBefore);
            property_managerPromotionOnlyViaAccept();
            property_acceptNeverZerosManager();
        } catch {}
    }

    function gPv2AllowListAuthentication_acceptManagership_asGuardian() public asGuardian {
        ghosts.lastOp = DIR_ACCEPT;
        address pendingBefore = authentication.pendingManager();
        snapshotBefore();
        try authentication.acceptManagership() {
            snapshotAfter();
            ghosts.lastCallWasAccept = true;
            if (GUARDIAN_ROLE != pendingBefore) {
                ghosts.nonExactAcceptSucceeded = true;
            }
            if (authentication.manager() == address(0)) {
                ghosts.acceptManagershipEverZeroedManager = true;
            }
            property_acceptManagershipAtomicPair(pendingBefore);
            property_managerPromotionOnlyViaAccept();
            property_acceptNeverZerosManager();
        } catch {}
    }

    function gPv2AllowListAuthentication_setManager(address manager_) public asActor {
        ghosts.lastOp = DIR_SETMGR;
        ghosts.lastCallWasAccept = false;
        bool wasAuthorized = authentication.manager() == actor;
        snapshotBefore();
        try authentication.setManager(manager_) {
            snapshotAfter();
            if (!wasAuthorized) {
                ghosts.unauthorizedDirectManagerMutation = true;
            } else {
                if (manager_ == address(0)) {
                    ghosts.managerEverZeroed = true;
                }
                property_directSetManagerAtomicPair(manager_);
            }
            property_managerPromotionOnlyViaAccept();
        } catch {}
    }

    function gPv2AllowListAuthentication_setManager_asAdmin(address manager_) public asTimelock {
        ghosts.lastOp = DIR_SETMGR;
        ghosts.lastCallWasAccept = false;
        snapshotBefore();
        try authentication.setManager(manager_) {
            snapshotAfter();
            if (manager_ == address(0)) {
                ghosts.managerEverZeroed = true;
            }
            property_directSetManagerAtomicPair(manager_);
            property_managerPromotionOnlyViaAccept();
        } catch {
            // The admin branch of onlyManagerOrOwner never depends on
            // `manager` or `manager_` -- this must never fail (SP-25).
            ghosts.adminRescueEverFailed = true;
        }
        property_adminRescueAlwaysLive();
    }

    function _gPv2AllowListAuthentication_cancelManagerTransfer() internal asActor {
        ghosts.lastOp = DIR_CANCEL;
        ghosts.lastCallWasAccept = false;
        bool wasAuthorized = authentication.manager() == actor;
        snapshotBefore();
        try authentication.cancelManagerTransfer() {
            snapshotAfter();
            if (!wasAuthorized) {
                ghosts.unauthorizedDirectManagerMutation = true;
                if (authentication.pendingManager() != stateBefore.pendingManager) {
                    ghosts.unauthorizedPendingManagerMutation = true;
                }
            } else {
                property_cancelIsSafeNoOp();
            }
            property_pendingManagerSlotProtected();
        } catch {}
    }

    function _gPv2AllowListAuthentication_cancelManagerTransfer_asAdmin() internal asTimelock {
        ghosts.lastOp = DIR_CANCEL;
        ghosts.lastCallWasAccept = false;
        snapshotBefore();
        authentication.cancelManagerTransfer();
        snapshotAfter();
        property_proposeCancelRoundTrip();
        property_cancelIsSafeNoOp();
    }

    /// Idempotency-guard probe: `initializeManager` was already called once
    /// in Base.setup(). Every fuzzer-reachable call here must revert
    /// ("Initializable: initialized") regardless of caller or argument --
    /// caller identity is irrelevant to this guard, so a fixed asActor is
    /// enough.
    function _gPv2AllowListAuthentication_initializeManager(address manager_) internal asActor {
        ghosts.lastOp = INIT;
        try authentication.initializeManager(manager_) {
            ghosts.initializeManagerSucceededTwice = true;
        } catch {}
    }

    // ─── Bespoke multi-identity handler (SP-04) ────────────────────────
    // NOT asActor/asAdmin/etc. -- a cooperative 4-step manager round trip
    // needs 2 different caller identities within a single handler call, so
    // it uses explicit vm.prank per step instead of a single wrapping
    // modifier (nesting vm.prank inside an asActor-style startPrank/
    // stopPrank pair would corrupt the prank stack).

    /// SP-04 [EXPLORATORY]: established manager M0 proposes B, B accepts,
    /// B proposes M0 back, M0 accepts -- the two-step transfer rail is
    /// fully reversible with no residual/dust state.
    function gPv2AllowListAuthentication_managerRoundTrip(uint256 bSeed) public {
        address m0 = authentication.manager();
        address b = toActor(address(uint160(bSeed)));
        if (b == m0) return;

        snapshotBefore();

        vm.prank(m0);
        authentication.proposeManager(b);

        vm.prank(b);
        authentication.acceptManagership();

        vm.prank(b);
        authentication.proposeManager(m0);

        vm.prank(m0);
        authentication.acceptManagership();

        snapshotAfter();
        ghosts.lastOp = DIR_ACCEPT;
        ghosts.lastCallWasAccept = true;
        property_managerRoundTripReversible(m0);
    }
}
