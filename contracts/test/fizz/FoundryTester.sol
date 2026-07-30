// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Handlers} from "./handlers/Handlers.sol";

/// @notice Contract to be used for quick testing with Foundry
contract FoundryTester is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    function setUp() public {
        setup();
    }

    // forge test --match-test test_sequence -vvv
    function test_sequence() public {
        // Add here call sequence to Handler's functions to reproduce failing property
    }

    // ── Violation Repros (Step 11) ────────────────────────────────────
    // Deterministic minimal reproductions of the 3 EXPLORATORY leads the
    // Medusa campaign fired. All 3 trace to the SAME documented root cause:
    // the X-1 binding `authentication.manager() == address(allowListGuardian)`
    // is NOT enforced on-chain (x-ray/invariants.md X-1: "on-chain: No —
    // install-script responsibility"). These are LEADS for human review, not
    // confirmed protocol bugs — every call in each sequence is individually
    // authorized. Run all with:
    //   forge test --match-contract FoundryTester -vvv

    /// SP-21 [EXPLORATORY lead]: the guardian Safe gains INSTANT, undelayed,
    /// unmonitored solver-add capability by becoming the authenticator manager
    /// directly (bypassing AllowListGuardian) — inverting the SLOW-add/FAST-evict
    /// design. No `SolverAddedViaTimelock` event fires. Every call is authorized.
    function test_repro_SP21_guardianGainsInstantAdd() public {
        // 1. admin (= timelock, the EIP-1967 proxy owner) proposes GUARDIAN_ROLE.
        vm.prank(TIMELOCK_ROLE);
        authentication.proposeManager(GUARDIAN_ROLE);
        // 2. GUARDIAN_ROLE accepts — becomes manager directly on the authenticator.
        vm.prank(GUARDIAN_ROLE);
        authentication.acceptManagership();
        assertEq(authentication.manager(), GUARDIAN_ROLE, "guardian did not become manager");
        // 3. GUARDIAN_ROLE now instant-adds a solver with zero timelock delay.
        address solver = address(0xBEEF);
        vm.prank(GUARDIAN_ROLE);
        authentication.addSolver(solver);
        assertTrue(authentication.isSolver(solver), "instant guardian add did not land");
    }

    /// SP-23 [EXPLORATORY lead]: X-2 ("a frozen timelock never blocks eviction")
    /// is only CONDITIONAL. The timelock's own ordinary `setManager` (moving the
    /// manager off the Guardian) silently disables the guardian's fast-evict
    /// fail-safe — subsequent `removeSolver` reverts.
    function test_repro_SP23_timelockBreaksEvictLiveness() public {
        address solver = address(0xBEEF);
        vm.prank(TIMELOCK_ROLE);
        allowListGuardian.addSolver(solver); // SLOW-path add (X-1 intact)
        assertTrue(authentication.isSolver(solver), "seed add failed");
        // timelock moves the manager off the Guardian ("migrate governance").
        vm.prank(TIMELOCK_ROLE);
        allowListGuardian.setManager(address(0xA11CE));
        // the guardian's instant defensive eviction now reverts.
        vm.prank(GUARDIAN_ROLE);
        vm.expectRevert(bytes("GPv2: caller not manager"));
        allowListGuardian.removeSolver(solver);
        assertTrue(authentication.isSolver(solver), "solver unexpectedly evicted");
    }

    /// SP-24 [EXPLORATORY lead]: a single direct `setManager(0)` (no zero-check at
    /// the authenticator layer, I-3) bricks BOTH the add and the evict path
    /// system-wide. Recoverable only via the EIP-1967 admin (SP-25) — so not
    /// permanent, but a genuine DoS edge state.
    function test_repro_SP24_zeroManagerBricksBothPaths() public {
        vm.prank(TIMELOCK_ROLE);
        authentication.setManager(address(0));
        assertEq(authentication.manager(), address(0), "manager not zeroed");
        // Guardian-forwarded add (as timelock) now reverts.
        vm.prank(TIMELOCK_ROLE);
        vm.expectRevert(bytes("GPv2: caller not manager"));
        allowListGuardian.addSolver(address(0xBEEF));
        // Guardian-forwarded evict (as guardian) also reverts.
        vm.prank(GUARDIAN_ROLE);
        vm.expectRevert(bytes("GPv2: caller not manager"));
        allowListGuardian.removeSolver(address(0xBEEF));
        // Recovery: the EIP-1967 admin can still setManager (SP-25) — not permanent.
        vm.prank(TIMELOCK_ROLE);
        authentication.setManager(address(allowListGuardian));
        assertEq(authentication.manager(), address(allowListGuardian), "admin rescue failed");
    }
}
