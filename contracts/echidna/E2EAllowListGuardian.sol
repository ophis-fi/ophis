// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.7.6 <0.9.0;

import {AllowListGuardian} from "../src/contracts/AllowListGuardian.sol";

/// @dev Minimal authenticator stand-in. Records whether ANY add/remove/
/// setManager ever landed, so the invariants catch an unauthorized mutation
/// regardless of which address was targeted (stronger than checking a fixed
/// address set).
contract MockAuthenticator {
    mapping(address => bool) public isSolver;
    address public manager;
    bool public anySolverAdded;
    bool public anySolverRemoved;
    bool public managerEverSet;

    function addSolver(address s) external {
        isSolver[s] = true;
        anySolverAdded = true;
    }

    function removeSolver(address s) external {
        isSolver[s] = false;
        anySolverRemoved = true;
    }

    function setManager(address m) external {
        manager = m;
        managerEverSet = true;
    }
}

/// @dev Echidna harness for AllowListGuardian (#442 timelock).
///
/// Model: the guardian's `timelock` and `guardian` roles are set to addresses
/// that are NOT in Echidna's sender set (`0x10000/0x20000/0x30000`, in
/// echidna.yaml). Echidna calls every external function (addSolver,
/// removeSolver, setManager, setGuardian) as those senders with fuzzed args.
/// Because no sender holds either role, EVERY privileged call must revert and
/// NO authenticator state may change. Any invariant returning false means an
/// access-control bypass was found.
///
/// This fuzzes the unconditionally-true security property: no non-timelock
/// principal can ever cause a solver-add or manager-handoff (timelock is
/// immutable; addSolver/setManager/setGuardian are onlyTimelock), and no
/// non-guardian principal can cause a removeSolver.
///
/// NOTE: solc 0.7.6 forbids reading `immutable` vars during construction, so
/// the harness keeps an empty constructor body and recovers `authenticator`
/// via a post-construction view helper.
contract E2EAllowListGuardian is AllowListGuardian {
    // Roles deliberately OUTSIDE Echidna's sender set.
    address internal constant TIMELOCK_ROLE = address(0xCAFE);
    address internal constant GUARDIAN_ROLE = address(0xBEEF);

    constructor() AllowListGuardian(address(new MockAuthenticator()), TIMELOCK_ROLE, GUARDIAN_ROLE) {}

    function _mock() internal view returns (MockAuthenticator) {
        return MockAuthenticator(address(authenticator));
    }

    // ---------------- invariants ----------------

    /// No Echidna sender is the timelock, so no addSolver may ever land.
    function echidna_no_solver_added() public view returns (bool) {
        return !_mock().anySolverAdded();
    }

    /// No Echidna sender is the guardian, so no removeSolver may ever land.
    function echidna_no_solver_removed() public view returns (bool) {
        return !_mock().anySolverRemoved();
    }

    /// No Echidna sender is the timelock, so setManager may never be forwarded.
    function echidna_manager_never_set() public view returns (bool) {
        return !_mock().managerEverSet() && _mock().manager() == address(0);
    }

    /// setGuardian is onlyTimelock; no sender is the timelock, so the guardian
    /// role can never be reassigned by the fuzzer.
    function echidna_guardian_unchanged() public view returns (bool) {
        return guardian == GUARDIAN_ROLE;
    }

    /// timelock is immutable and was set to TIMELOCK_ROLE; it can never change.
    function echidna_timelock_unchanged() public view returns (bool) {
        return timelock == TIMELOCK_ROLE;
    }

    /// guardian is never zero (constructor + setGuardian both reject zero).
    function echidna_guardian_never_zero() public view returns (bool) {
        return guardian != address(0);
    }
}
