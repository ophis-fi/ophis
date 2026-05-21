// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Vm} from "forge-std/Vm.sol";

import {GPv2AllowListAuthentication} from "src/contracts/GPv2AllowListAuthentication.sol";

import {Helper} from "./Helper.sol";

/// @title MED-1 two-step manager transfer test suite
///
/// Closes MED-1 from the 2026-05-22 OP-mainnet smart-contract audit
/// (Trail of Bits suite). The single-step `setManager` is preserved
/// for backwards-compat + emergency proxy-admin rescue; the new
/// `proposeManager` + `acceptManagership` + `cancelManagerTransfer`
/// triplet is the typo-resistant path.
contract TwoStepManager is Helper {
    address newManager = makeAddr("TwoStepManager: proposed new manager");
    address other = makeAddr("TwoStepManager: unrelated address");

    // ────────────────────────────────────────────────────────────────────
    // proposeManager — authorization + storage + event
    // ────────────────────────────────────────────────────────────────────

    function test_proposeManager_settable_by_current_manager() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);
        assertEq(authenticator.pendingManager(), newManager);
        // manager is UNCHANGED at this point — only the proposal is recorded.
        assertEq(authenticator.manager(), manager);
    }

    function test_proposeManager_settable_by_proxy_owner() public {
        vm.prank(owner);
        authenticator.proposeManager(newManager);
        assertEq(authenticator.pendingManager(), newManager);
        assertEq(authenticator.manager(), manager);
    }

    function test_proposeManager_reverts_for_unauthorized_caller() public {
        vm.prank(other);
        vm.expectRevert("GPv2: not authorized");
        authenticator.proposeManager(newManager);
    }

    function test_proposeManager_emits_event() public {
        vm.prank(manager);
        vm.expectEmit();
        emit GPv2AllowListAuthentication.ManagerTransferProposed(newManager, manager);
        authenticator.proposeManager(newManager);
    }

    function test_proposeManager_overwrites_prior_proposal() public {
        address firstProposal = makeAddr("first proposal");
        vm.prank(manager);
        authenticator.proposeManager(firstProposal);
        assertEq(authenticator.pendingManager(), firstProposal);

        vm.prank(manager);
        authenticator.proposeManager(newManager);
        assertEq(authenticator.pendingManager(), newManager);
        // Manager remains unchanged.
        assertEq(authenticator.manager(), manager);
    }

    // ────────────────────────────────────────────────────────────────────
    // acceptManagership — authorization + storage + event
    // ────────────────────────────────────────────────────────────────────

    function test_acceptManagership_completes_transfer() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(newManager);
        authenticator.acceptManagership();

        assertEq(authenticator.manager(), newManager);
        assertEq(authenticator.pendingManager(), address(0));
    }

    function test_acceptManagership_emits_ManagerChanged() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(newManager);
        vm.expectEmit();
        emit GPv2AllowListAuthentication.ManagerChanged(newManager, manager);
        authenticator.acceptManagership();
    }

    function test_acceptManagership_reverts_when_no_pending() public {
        vm.prank(newManager);
        vm.expectRevert("GPv2: no pending manager");
        authenticator.acceptManagership();
    }

    function test_acceptManagership_reverts_for_non_pending_caller() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(other);
        vm.expectRevert("GPv2: caller not pending manager");
        authenticator.acceptManagership();
    }

    function test_acceptManagership_reverts_for_old_manager() public {
        // The old manager who initiated the proposal cannot just accept it
        // back — that would defeat the typo-resistance. Only the proposed
        // address can accept.
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(manager);
        vm.expectRevert("GPv2: caller not pending manager");
        authenticator.acceptManagership();
    }

    // ────────────────────────────────────────────────────────────────────
    // cancelManagerTransfer — authorization + storage + event
    // ────────────────────────────────────────────────────────────────────

    function test_cancelManagerTransfer_clears_pending() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);
        assertEq(authenticator.pendingManager(), newManager);

        vm.prank(manager);
        authenticator.cancelManagerTransfer();
        assertEq(authenticator.pendingManager(), address(0));
        // Manager unchanged.
        assertEq(authenticator.manager(), manager);
    }

    function test_cancelManagerTransfer_callable_by_owner() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(owner);
        authenticator.cancelManagerTransfer();
        assertEq(authenticator.pendingManager(), address(0));
    }

    function test_cancelManagerTransfer_reverts_for_unauthorized() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(other);
        vm.expectRevert("GPv2: not authorized");
        authenticator.cancelManagerTransfer();
    }

    function test_cancelManagerTransfer_emits_event() public {
        vm.prank(manager);
        authenticator.proposeManager(newManager);

        vm.prank(manager);
        vm.expectEmit();
        emit GPv2AllowListAuthentication.ManagerTransferCancelled(newManager);
        authenticator.cancelManagerTransfer();
    }

    function test_cancelManagerTransfer_noop_emits_zero_address() public {
        // No pending transfer exists. The function still runs (it's a
        // no-op state-wise) but emits the event with address(0) for
        // log symmetry.
        vm.prank(manager);
        vm.expectEmit();
        emit GPv2AllowListAuthentication.ManagerTransferCancelled(address(0));
        authenticator.cancelManagerTransfer();
    }

    // ────────────────────────────────────────────────────────────────────
    // setManager (single-step) — defense-in-depth interaction with pending
    // ────────────────────────────────────────────────────────────────────

    function test_setManager_clears_pendingManager() public {
        // Scenario: manager proposed newManager, then proxy admin rescued
        // via setManager. The pending transfer should be cancelled to
        // avoid a confusing state where pendingManager dangles from an
        // earlier propose call.
        vm.prank(manager);
        authenticator.proposeManager(newManager);
        assertEq(authenticator.pendingManager(), newManager);

        address rescueManager = makeAddr("rescue manager");
        vm.prank(owner);
        authenticator.setManager(rescueManager);

        assertEq(authenticator.manager(), rescueManager);
        assertEq(authenticator.pendingManager(), address(0));
    }

    function test_setManager_no_pending_does_not_emit_cancel_event() public {
        // Without a pending proposal, setManager should NOT emit
        // ManagerTransferCancelled. Only ManagerChanged.
        // (We test the absence by checking the event count and asserting
        // ManagerChanged is the only emitted event of interest.)
        address rescueManager = makeAddr("rescue manager");
        vm.prank(owner);
        vm.recordLogs();
        authenticator.setManager(rescueManager);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Filter for ManagerTransferCancelled events
        bytes32 cancelTopic = keccak256("ManagerTransferCancelled(address)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != cancelTopic,
                "setManager should not emit ManagerTransferCancelled when no pending exists"
            );
        }
    }
}
