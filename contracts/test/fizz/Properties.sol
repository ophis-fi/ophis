// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Snapshots} from "./Snapshots.sol";
import {PropertiesAsserts} from "./utils/PropertiesAsserts.sol";
import {vm} from "./utils/Hevm.sol";
import {GPv2EIP1967} from "../../src/contracts/libraries/GPv2EIP1967.sol";

/// @notice Contains the functions that check the properties (invariants)
abstract contract Properties is PropertiesAsserts, Snapshots {

    // ―――――――――――――――――――― Global properties ―――――――――――――――――――――
    // These properties must always hold after any function call.
    // They MUST BE PUBLIC so that fuzzers can find and call them.

    /// @notice GL-01: Guardian add/remove/setManager succeed only while manager()==address(allowListGuardian) (the X-1 binding), recomputed live and never cached
    function property_guardianAuthorityIsX1Binding() public {
        // Live read (never cached, per VS-03 in fizz_data/property-plan.md):
        //   bool x1Bound = authentication.manager() == address(allowListGuardian);
        // This global documents the X-1 condition only. Asserting on it
        // directly would false-positive on the legitimate state where the
        // timelock has migrated manager() away from the Guardian (X-1 not
        // holding is a valid, reachable state, not a bug by itself). The
        // real enforcement teeth live in SP-05/SP-06/SP-07 (Guardian-call
        // postconditions gated by X-1) and GL-04 (direct-path exact access
        // control).
        t(true, "GL-01: documenting-only, teeth in SP-05/06/07 + GL-04");
    }

    /// @notice GL-02: no caller other than timelock ever caused a solver-add, manager handoff, or guardian rotation through AllowListGuardian
    function property_noUnauthorizedGuardianAddOrRotate() public {
        t(
            !ghosts.unauthorizedGuardianAdd && !ghosts.unauthorizedGuardianManagerChange
                && !ghosts.unauthorizedGuardianRotation,
            "GL-02: unauthorized guardian-path mutation"
        );
    }

    /// @notice GL-03: no caller other than guardian ever caused a solver removal through AllowListGuardian
    function property_noUnauthorizedGuardianRemove() public {
        t(!ghosts.unauthorizedGuardianRemove, "GL-03: unauthorized guardian removeSolver");
    }

    /// @notice GL-04: direct add/remove only by the current manager; setManager/proposeManager/cancelManagerTransfer only by manager or admin
    function property_directAuthExactAccessControl() public {
        t(
            !ghosts.unauthorizedDirectAdd && !ghosts.unauthorizedDirectRemove
                && !ghosts.unauthorizedDirectManagerMutation,
            "GL-04: unauthorized direct-path mutation"
        );
    }

    /// @notice GL-05: the EIP-1967 admin's authority over setManager/proposeManager/cancelManagerTransfer is never revoked by a manager handoff
    function property_adminAuthorityPersistsAcrossHandoffs() public {
        // Live-probe: cancelManagerTransfer is a side-effect-light legal
        // action for the admin (no-op if nothing is pending), so it is safe
        // to fire every call without perturbing unrelated state.
        vm.prank(ghosts.initialAdmin);
        try authentication.cancelManagerTransfer() {}
        catch {
            t(false, "GL-05: admin lost authority");
        }
    }

    /// @notice GL-06 [EXPLORATORY]: nothing enforces getAdmin()==allowListGuardian.timelock() -- documents whether the live coincidence still holds in this harness
    function property_adminEqualsTimelockUnenforced() public {
        t(ghosts.initialAdmin == allowListGuardian.timelock(), "GL-06: admin!=timelock (unenforced binding drifted)");
    }

    /// @notice GL-07 [EXPLORATORY]: once manager()!=Guardian, only a direct authenticator call can restore X-1, never via the Guardian
    function property_x1RestorationRequiresDirectCall() public {
        // TODO: "which call-site restored X-1" is a reachability/path fact
        // (what the PRIOR call was), not a point-in-time invariant checkable
        // cheaply from a global property with no path ghost wired to it. No
        // non-brittle per-call assertion. Marked [-] in PROPERTIES.md.
        t(true, "GL-07: documenting-only stub, see property-plan.md EXPLORATORY note");
    }

    /// @notice GL-08: direct authenticator calls never mutate Guardian storage; setGuardian never reaches the authenticator
    function property_crossContractStorageIsolation() public {
        t(
            address(allowListGuardian.authenticator()) == address(authentication)
                && allowListGuardian.timelock() == TIMELOCK_ROLE,
            "GL-08: guardian storage bled by authenticator calls"
        );
    }

    /// @notice GL-09: acceptManagership only ever makes the EXACT most-recently proposed address the manager
    function property_noStaleOrNonExactAccept() public {
        t(!ghosts.nonExactAcceptSucceeded, "GL-09: non-exact/stale accept succeeded");
    }

    /// @notice GL-10: manager is only ever written by initializeManager/setManager/acceptManagership (documenting-only)
    function property_managerWriterSetExact() public {
        // TODO: writer-set exactness (only 3 assign sites in
        // GPv2AllowListAuthentication.sol) is a source-level fact, not
        // something observable per-call from outside the contract without a
        // writer-tag ghost at every possible call site. No non-brittle
        // runtime assertion beyond that. Marked [-] in PROPERTIES.md.
        t(true, "GL-10: documenting-only stub, writer-set exactness is source-verified");
    }

    /// @notice GL-11: pendingManager is only ever written by propose/accept/cancel/setManager, and only propose raises it off 0 (documenting-only)
    function property_pendingManagerWriterSetExact() public {
        // TODO: same rationale as GL-10 -- writer-set exactness is verified
        // at the source level; no non-brittle per-call runtime assertion.
        // Marked [-] in PROPERTIES.md.
        t(true, "GL-11: documenting-only stub, writer-set exactness is source-verified");
    }

    /// @notice GL-12: guardian is only ever written by the constructor + setGuardian, both non-zero (documenting-only)
    function property_guardianWriterSetExact() public {
        // TODO: writer-set exactness is a source-level fact (2 assign
        // sites); the non-zero half of this claim is GL-13's job (asserted
        // there), so a runtime check here would just duplicate it. Marked
        // [-] in PROPERTIES.md.
        t(true, "GL-12: documenting-only stub, see GL-13 for the non-zero teeth");
    }

    /// @notice GL-13: allowListGuardian.guardian() != address(0) always
    function property_guardianNeverZero() public {
        t(allowListGuardian.guardian() != address(0), "GL-13: guardian is zero");
    }

    /// @notice GL-14: timelock/authenticator equal their constructor values always (immutable)
    function property_timelockAndAuthenticatorImmutable() public {
        t(
            allowListGuardian.timelock() == TIMELOCK_ROLE
                && address(allowListGuardian.authenticator()) == address(authentication),
            "GL-14: immutable timelock/authenticator drifted"
        );
    }

    /// @notice GL-15: manager reaches 0 only via a direct setManager(0), never Guardian/accept/propose+accept (documenting-only)
    function property_managerZeroOnlyViaDirectSetManager() public {
        // TODO: "reached 0 only via this call-site" is a path/reachability
        // fact requiring a writer-tag ghost at every manager-assignment
        // site; the mechanics (Guardian rejects 0, accept requires
        // pending!=0) are covered by SP-12/SP-16/SP-24 at the handler
        // level. No non-brittle global assertion. Marked [-] in
        // PROPERTIES.md.
        t(true, "GL-15: documenting-only stub, mechanics covered by SP-12/SP-16/SP-24");
    }

    /// @notice GL-16: the EIP-1967 admin slot never drifts from ghosts.initialAdmin
    function property_adminSlotNeverDrifts() public {
        address a = address(uint160(uint256(vm.load(address(authentication), GPv2EIP1967.ADMIN_SLOT))));
        t(a == ghosts.initialAdmin, "GL-16: admin slot drifted");
    }

    /// @notice GL-17: initializeManager reverts for every caller/arg post-setup (one-way latch)
    function property_initializerPermanentlyClosed() public {
        t(!ghosts.initializeManagerSucceededTwice, "GL-17: initializeManager succeeded again");
        try authentication.initializeManager(address(this)) {
            t(false, "GL-17: re-init succeeded");
        } catch {}
    }

    /// @notice GL-18 [VALID_STATE]: while manager()==0, no onlyManager function is callable by any fuzzer address
    function property_managerZeroFailSafeState() public {
        if (authentication.manager() == address(0)) {
            vm.prank(actor);
            try authentication.addSolver(address(1)) {
                t(false, "GL-18: addSolver worked while manager==0");
            } catch {}
        }
    }

    /// @notice GL-19 [VALID_STATE]: while pendingManager()==X, X gains no privilege other than acceptManagership
    function property_pendingManagerGrantsNoPrivilege() public {
        address p = authentication.pendingManager();
        if (p != address(0) && p != authentication.manager() && p != ghosts.initialAdmin) {
            vm.prank(p);
            try authentication.addSolver(address(2)) {
                t(false, "GL-19: pending manager had privilege");
            } catch {}
        }
    }

    // ――――――――――――――――――― Specific properties ――――――――――――――――――――
    // These properties must hold after specific function calls.
    // They MUST BE INTERNAL and called at the end of the relevant handlers.

    /// @notice SP-01: after a successful addSolver(s) the target is a solver; after a successful removeSolver(s) it is not (absorbing, idempotent)
    function property_solverSetAbsorbingAndIdempotent(address solver, bool wasAdd) internal {
        if (wasAdd) {
            t(authentication.isSolver(solver), "SP-01: addSolver did not leave isSolver true");
        } else {
            t(!authentication.isSolver(solver), "SP-01: removeSolver did not leave isSolver false");
        }
    }

    /// @notice SP-02: proposeManager(x) then cancelManagerTransfer (admin branch) ends with pendingManager==0 and manager unchanged from before the propose
    function property_proposeCancelRoundTrip() internal {
        if (stateBefore.pendingManager != address(0)) {
            t(authentication.pendingManager() == address(0), "SP-02: pendingManager not cleared by cancel");
            t(authentication.manager() == stateBefore.manager, "SP-02: manager mutated by cancel");
        }
    }

    /// @notice SP-03: cancelManagerTransfer with no pending proposal is a safe no-op (no revert, state untouched)
    function property_cancelIsSafeNoOp() internal {
        if (stateBefore.pendingManager == address(0)) {
            t(authentication.pendingManager() == address(0), "SP-03: no-op cancel left pendingManager nonzero");
            t(authentication.manager() == stateBefore.manager, "SP-03: no-op cancel mutated manager");
        }
    }

    /// @notice SP-04 [EXPLORATORY]: cooperative M0->B->M0 round trip returns manager to M0 with pendingManager cleared, no residual state
    function property_managerRoundTripReversible(address m0) internal {
        t(authentication.manager() == m0, "SP-04: manager did not return to M0 after round trip");
        t(authentication.pendingManager() == address(0), "SP-04: pendingManager left dangling after round trip");
    }

    /// @notice SP-05: a successful Guardian.addSolver(s) (as timelock) results in isSolver(s)==true, and can only succeed while X-1 (manager==Guardian) holds
    function property_guardianAddSolverPostcondition(address solver) internal {
        t(authentication.isSolver(solver), "SP-05: guardian addSolver did not set isSolver true");
        t(stateBefore.manager == address(allowListGuardian), "SP-05: guardian addSolver succeeded without X-1 binding");
    }

    /// @notice SP-06: a successful Guardian.removeSolver(s) (as guardian) results in isSolver(s)==false, conditional on X-1
    function property_guardianRemoveSolverPostcondition(address solver) internal {
        t(!authentication.isSolver(solver), "SP-06: guardian removeSolver did not set isSolver false");
        t(stateBefore.manager == address(allowListGuardian), "SP-06: guardian removeSolver succeeded without X-1 binding");
    }

    /// @notice SP-07: a successful Guardian.setManager(m!=0) (as timelock) leaves manager()==m AND pendingManager()==0 (forward clears any dangling proposal)
    function property_guardianSetManagerPostcondition(address newManager) internal {
        t(authentication.manager() == newManager, "SP-07: guardian setManager did not set manager to m");
        t(authentication.pendingManager() == address(0), "SP-07: guardian setManager left pendingManager dangling");
    }

    /// @notice SP-08: a successful Guardian.setGuardian(g!=0) (as timelock) sets guardian()==g and touches nothing on the authenticator
    function property_guardianSetGuardianTouchesNoAuth(address newGuardian) internal {
        t(allowListGuardian.guardian() == newGuardian, "SP-08: setGuardian did not set guardian");
        t(stateAfter.manager == stateBefore.manager, "SP-08: setGuardian touched authenticator manager");
        t(stateAfter.pendingManager == stateBefore.pendingManager, "SP-08: setGuardian touched authenticator pendingManager");
    }

    /// @notice SP-09: a direct authentication.addSolver(s) succeeds iff the effective caller equals manager() at call time, then isSolver(s)==true
    function property_directAddSolverIffManager(address solver, address caller) internal {
        t(stateBefore.manager == caller, "SP-09: direct addSolver succeeded without caller==manager");
        t(authentication.isSolver(solver), "SP-09: direct addSolver did not set isSolver true");
    }

    /// @notice SP-10: a direct authentication.removeSolver(s) succeeds iff the effective caller equals manager() at call time, then isSolver(s)==false
    function property_directRemoveSolverIffManager(address solver, address caller) internal {
        t(stateBefore.manager == caller, "SP-10: direct removeSolver succeeded without caller==manager");
        t(!authentication.isSolver(solver), "SP-10: direct removeSolver did not set isSolver false");
    }

    /// @notice SP-11: add/removeSolver flips only the target's isSolver; manager/pendingManager are untouched (frame condition)
    function property_solverOpFrameCondition() internal {
        t(stateAfter.manager == stateBefore.manager, "SP-11: solver op mutated manager");
        t(stateAfter.pendingManager == stateBefore.pendingManager, "SP-11: solver op mutated pendingManager");
    }

    /// @notice SP-12: a successful direct setManager(m) is an atomic pair: manager==m (any m incl 0) AND pendingManager==0
    function property_directSetManagerAtomicPair(address m) internal {
        t(authentication.manager() == m, "SP-12: setManager did not set manager to m");
        t(authentication.pendingManager() == address(0), "SP-12: setManager left pendingManager nonzero");
    }

    /// @notice SP-13: a successful proposeManager(m) sets pendingManager==m unconditionally, manager unchanged, and never reverts
    function property_proposeManagerUnconditional(address m) internal {
        t(authentication.pendingManager() == m, "SP-13: proposeManager did not set pendingManager to m");
        t(authentication.manager() == stateBefore.manager, "SP-13: proposeManager mutated manager");
    }

    /// @notice SP-14: a successful acceptManagership() is an atomic pair: manager==priorPending AND pendingManager==0
    function property_acceptManagershipAtomicPair(address pendingBefore) internal {
        t(authentication.manager() == pendingBefore, "SP-14: accept did not promote the exact prior pending manager");
        t(authentication.pendingManager() == address(0), "SP-14: accept left pendingManager nonzero");
    }

    /// @notice SP-15 [EXPLORATORY]: manager becoming the prior pendingManager was produced by acceptManagership OR by a coincidental single-step setManager to that same value -- never by any OTHER path
    function property_managerPromotionOnlyViaAccept() internal {
        if (
            stateBefore.pendingManager != address(0) && stateAfter.manager == stateBefore.pendingManager
                && stateAfter.manager != stateBefore.manager
        ) {
            // The prior strict form ("must be acceptManagership") false-fired on
            // the LEGITIMATE coincidental-match case that Agent 3 flagged:
            // `setManager(x)` (direct or Guardian-forwarded) with x == the prior
            // pendingManager sets manager to that value without being an accept,
            // and clears pending. That is a legal single-step transfer, not a
            // bug. The genuine invariant is that NO path OTHER than
            // acceptManagership or setManager can promote manager to the prior
            // pending value -- so accept it via either, and only fail on a
            // hypothetical third path.
            bool viaAccept = ghosts.lastCallWasAccept;
            bool viaSetManager = (ghosts.lastOp == DIR_SETMGR || ghosts.lastOp == GUARD_SETMGR);
            t(
                viaAccept || viaSetManager,
                "SP-15: manager promoted to prior pending via neither accept nor setManager"
            );
        }
    }

    /// @notice SP-16: acceptManagership can never zero the manager (the two-step rail is zero-brick-proof)
    function property_acceptNeverZerosManager() internal {
        t(!ghosts.acceptManagershipEverZeroedManager, "SP-16: acceptManagership zeroed the manager (ghost)");
        t(authentication.manager() != address(0), "SP-16: acceptManagership zeroed the manager");
    }

    /// @notice SP-17: cross-role rejection at the Guardian layer -- guardian never succeeds on timelock-only fns, timelock never succeeds on the guardian-only removeSolver
    function property_crossRoleRejection() internal {
        t(!ghosts.guardianSucceededOnTimelockOnlyFn, "SP-17: guardian succeeded on a timelock-only Guardian fn");
        t(!ghosts.timelockSucceededOnGuardianOnlyFn, "SP-17: timelock succeeded on the guardian-only removeSolver");
    }

    /// @notice SP-18: the guardian never entrenches or rotates itself -- guardian only ever changes via msg.sender==timelock
    function property_guardianCannotSelfEntrench() internal {
        t(!ghosts.guardianSelfRotated, "SP-18: guardian rotated itself without timelock");
    }

    /// @notice SP-19: no caller outside {current manager, EIP-1967 admin} can set, overwrite, or clear pendingManager
    function property_pendingManagerSlotProtected() internal {
        t(!ghosts.unauthorizedPendingManagerMutation, "SP-19: unauthorized pendingManager mutation");
    }

    /// @notice SP-20: AllowListGuardian's timelock-only functions succeed instantly -- two back-to-back same-block calls both succeed, no on-chain delay enforced
    function property_noOnChainDelayEnforced(address solverA, address solverB, uint256 blockBefore) internal {
        t(authentication.isSolver(solverA), "SP-20: first back-to-back addSolver did not take effect");
        t(authentication.isSolver(solverB), "SP-20: second back-to-back addSolver did not take effect");
        t(block.number == blockBefore, "SP-20: back-to-back calls did not stay in the same block");
    }

    /// @notice SP-21 [EXPECTED-VIOLATED lead]: guardian must never gain instant, undelayed, unmonitored solver-add capability once it becomes manager
    function property_guardianNeverGetsInstantAdd() internal {
        t(!ghosts.guardianBecameManagerThenInstantAdded, "SP-21: guardian gained instant add (X-1 inversion lead)");
    }

    /// @notice SP-22: while X-1 holds, the guardian's instant removeSolver is never blocked, delayed, or reverted (fail-safe eviction liveness)
    function property_evictLivenessWhileX1Held(address solver) internal {
        t(!authentication.isSolver(solver), "SP-22: guardian removeSolver liveness violated while X-1 held");
    }

    /// @notice SP-23 [EXPECTED-VIOLATED lead]: the timelock breaking the X-1 binding must never silently disable guardian eviction
    function property_evictLivenessLostIfX1Broken() internal {
        t(!ghosts.evictBlockedByBrokenBinding, "SP-23: timelock broke X-1 binding, guardian eviction silently disabled (lead)");
    }

    /// @notice SP-24 [EXPECTED-VIOLATED lead]: a direct setManager(0) must never brick both the direct and Guardian-forwarded add/remove paths system-wide
    function property_zeroManagerBricksBothPaths() internal {
        t(!ghosts.bothPathsBrickedByZeroManager, "SP-24: setManager(0) bricked both add and remove paths (lead)");
    }

    /// @notice SP-25: no matter the current manager value (including 0), the EIP-1967 admin can always successfully setManager to recover
    function property_adminRescueAlwaysLive() internal {
        t(!ghosts.adminRescueEverFailed, "SP-25: admin rescue setManager unexpectedly failed");
    }

    /// @notice SP-26 [EXPECTED-VIOLATED lead]: once X-1 is broken, the Guardian must not degrade to dead code with no self-heal while the new manager gains raw instant power
    function property_x1BrokenDeadCodeAndRawPower() internal {
        t(
            !(
                ghosts.timelockBrokeEvictBinding && ghosts.evictBlockedByBrokenBinding
                    && ghosts.guardianBecameManagerThenInstantAdded
            ),
            "SP-26: X-1-broken composite -- Guardian dead code + new manager raw power (lead)"
        );
    }
}
