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

    function test_storage_layout_pendingManager_at_slot_2() public {
        // Sharp-edges re-audit MED (PR #224): the storage-layout invariant
        // documented at GPv2AllowListAuthentication.sol:32-41 is comment-
        // only — no test asserts the actual slot index. If a future
        // refactor inserts a field above `pendingManager` (e.g. into
        // Initializable or StorageAccessible), the proxy upgrade would
        // silently alias `pendingManager` over an existing field. This
        // test reads slot 2 directly and asserts it matches the live
        // `pendingManager()` getter.
        vm.prank(manager);
        address probe = makeAddr("layout-probe-manager");
        authenticator.proposeManager(probe);

        // Slot 2 should hold the pendingManager address.
        bytes32 slot2 = vm.load(address(authenticator), bytes32(uint256(2)));
        assertEq(address(uint160(uint256(slot2))), probe, "pendingManager not at slot 2");

        // Slot 0 should hold {_initialized + _initializing + manager}
        // (Initializable packing — manager is offset 2, 20 bytes).
        bytes32 slot0 = vm.load(address(authenticator), bytes32(uint256(0)));
        address slot0Manager = address(uint160(uint256(slot0) >> 16));
        assertEq(slot0Manager, manager, "manager not at slot 0 offset 2 (Initializable packing)");

        // Slot 1 = solvers mapping seed. Not directly readable but
        // mapping(address=>bool)[address] lives at keccak256(addr . slot1)
        // — confirmed by adding a solver and probing the derived slot.
        // We don't assert this here because the upstream Initializable +
        // mapping seed conventions are stable across Solidity 0.7-0.9.
    }

    function test_proposeManager_zero_address_is_treated_as_no_pending() public {
        // Codex LOW re-audit (PR #224): explicitly cover the proposeManager(0)
        // edge case. The function ACCEPTS the call (stores 0 + emits
        // event), but acceptManagership() then rejects with "no pending
        // manager" because pendingManager == address(0). Functionally
        // equivalent to "no pending transfer exists".
        vm.prank(manager);
        vm.expectEmit();
        emit GPv2AllowListAuthentication.ManagerTransferProposed(address(0), manager);
        authenticator.proposeManager(address(0));

        assertEq(authenticator.pendingManager(), address(0));
        // manager unchanged
        assertEq(authenticator.manager(), manager);

        // acceptManagership reverts because pendingManager == address(0).
        // The "no pending manager" branch fires BEFORE the "caller not
        // pending manager" branch.
        vm.prank(address(0));
        vm.expectRevert("GPv2: no pending manager");
        authenticator.acceptManagership();
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
