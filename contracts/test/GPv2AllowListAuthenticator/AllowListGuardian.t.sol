// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {AllowListGuardian} from "src/contracts/AllowListGuardian.sol";
import {GPv2EIP1967} from "src/contracts/libraries/GPv2EIP1967.sol";

import {GPv2AllowListAuthenticationHarness} from "./Helper.sol";

/// @title AllowListGuardian (#442) test suite
///
/// Proves the SLOW/FAST split of the authenticator `manager()` role:
/// - addSolver / setManager / setGuardian are restricted to the timelock
///   (the OZ TimelockController whose >= 24h minDelay is configured + verified
///   in the install script; here the timelock is a pranked address since the
///   delay itself is OZ-audited behaviour, not this contract's logic);
/// - removeSolver is the INSTANT, guardian-only defensive eviction path.
contract AllowListGuardianTest is Test {
    GPv2AllowListAuthenticationHarness internal authenticator;
    AllowListGuardian internal guardianContract;

    address internal owner = makeAddr("owner (proxy admin / timelock in prod)");
    address internal timelock = makeAddr("timelock (OZ TimelockController, 24h)");
    address internal safe = makeAddr("guardian (protocol Safe)");
    address internal solver = makeAddr("a solver");
    address internal stranger = makeAddr("unauthorised stranger");

    function setUp() public {
        // Deploy the authenticator harness (emulates being behind an EIP-1967
        // proxy) and install the guardian as its manager().
        authenticator = new GPv2AllowListAuthenticationHarness(owner);
        guardianContract = new AllowListGuardian(address(authenticator), timelock, safe);
        authenticator.initializeManager(address(guardianContract));
    }

    // ─── wiring ──────────────────────────────────────────────────────────

    function test_constructor_wires_immutables_and_guardian() public view {
        assertEq(address(guardianContract.authenticator()), address(authenticator));
        assertEq(guardianContract.timelock(), timelock);
        assertEq(guardianContract.guardian(), safe);
        assertEq(authenticator.manager(), address(guardianContract));
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert("Guardian: zero address");
        new AllowListGuardian(address(0), timelock, safe);
        vm.expectRevert("Guardian: zero address");
        new AllowListGuardian(address(authenticator), address(0), safe);
        vm.expectRevert("Guardian: zero address");
        new AllowListGuardian(address(authenticator), timelock, address(0));
    }

    // ─── SLOW path: addSolver (timelock only) ────────────────────────────

    function test_addSolver_via_timelock_succeeds() public {
        vm.prank(timelock);
        guardianContract.addSolver(solver);
        assertTrue(authenticator.isSolver(solver));
    }

    function test_addSolver_by_guardian_reverts() public {
        // The dangerous op must NOT be available on the fast path.
        vm.prank(safe);
        vm.expectRevert("Guardian: caller not timelock");
        guardianContract.addSolver(solver);
    }

    function test_addSolver_by_stranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert("Guardian: caller not timelock");
        guardianContract.addSolver(solver);
    }

    // ─── FAST path: removeSolver (guardian only, instant) ────────────────

    function test_removeSolver_via_guardian_is_instant() public {
        vm.prank(timelock);
        guardianContract.addSolver(solver);
        assertTrue(authenticator.isSolver(solver));

        vm.prank(safe);
        guardianContract.removeSolver(solver);
        assertFalse(authenticator.isSolver(solver));
    }

    function test_removeSolver_by_timelock_reverts() public {
        vm.prank(timelock);
        guardianContract.addSolver(solver);
        // removeSolver is guardian-only; the timelock is not the fast path.
        vm.prank(timelock);
        vm.expectRevert("Guardian: caller not guardian");
        guardianContract.removeSolver(solver);
    }

    function test_removeSolver_by_stranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert("Guardian: caller not guardian");
        guardianContract.removeSolver(solver);
    }

    // ─── SLOW path: setManager (timelock only) ───────────────────────────

    function test_setManager_via_timelock_succeeds() public {
        address newManager = makeAddr("new manager");
        vm.prank(timelock);
        guardianContract.setManager(newManager);
        assertEq(authenticator.manager(), newManager);
    }

    function test_setManager_by_guardian_reverts() public {
        vm.prank(safe);
        vm.expectRevert("Guardian: caller not timelock");
        guardianContract.setManager(stranger);
    }

    // ─── SLOW path: setGuardian (timelock only) ──────────────────────────

    function test_setGuardian_via_timelock_succeeds() public {
        address newGuardian = makeAddr("new guardian Safe");
        vm.prank(timelock);
        guardianContract.setGuardian(newGuardian);
        assertEq(guardianContract.guardian(), newGuardian);

        // old guardian can no longer evict; new one can.
        vm.prank(timelock);
        guardianContract.addSolver(solver);
        vm.prank(safe);
        vm.expectRevert("Guardian: caller not guardian");
        guardianContract.removeSolver(solver);
        vm.prank(newGuardian);
        guardianContract.removeSolver(solver);
        assertFalse(authenticator.isSolver(solver));
    }

    function test_setGuardian_by_guardian_reverts() public {
        vm.prank(safe);
        vm.expectRevert("Guardian: caller not timelock");
        guardianContract.setGuardian(stranger);
    }

    function test_setGuardian_rejects_zero() public {
        vm.prank(timelock);
        vm.expectRevert("Guardian: zero guardian");
        guardianContract.setGuardian(address(0));
    }
}
