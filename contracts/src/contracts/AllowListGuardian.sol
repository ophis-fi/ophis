// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.7.6 <0.9.0;

/// @dev Minimal interface to the GPv2AllowListAuthentication functions this
/// guardian forwards to. The guardian becomes the authenticator's `manager()`.
interface IGPv2AllowListAuthentication {
    function addSolver(address solver) external;

    function removeSolver(address solver) external;

    function setManager(address manager_) external;

    function manager() external view returns (address);
}

/// @title AllowListGuardian
/// @notice Splits control of the GPv2AllowListAuthentication `manager()` role
/// into a SLOW, timelocked path and a FAST, guardian path (#442).
///
/// Once installed as the authenticator's `manager()`:
///
/// - **Adding a solver** (`addSolver`) and **handing off the manager role**
///   (`setManager`) are dangerous — a malicious solver can dispatch
///   settlements. They are restricted to `timelock` (an OpenZeppelin
///   `TimelockController` with a >= 24h `minDelay`), so every such change is
///   announced on-chain and cannot take effect for the delay window.
///
/// - **Removing a solver** (`removeSolver`) is purely defensive (it can only
///   reduce capability), so it stays INSTANT via the `guardian` (the protocol
///   Safe). Defensive eviction of a compromised submitter must never be
///   delayed.
///
/// The proxy upgrade admin (EIP-1967 owner) should be transferred to the SAME
/// `timelock` so contract upgrades are delayed too; that is done in the
/// install script, not here.
///
/// This contract holds no funds and stores no secrets.
///
/// FAILURE MODE (by design, fail-safe): `timelock` is immutable and is the ONLY
/// authority that can add a solver, upgrade, or hand off the manager role. If
/// the TimelockController is ever broken (e.g. all proposers' keys lost), the
/// SLOW path freezes permanently and there is NO on-contract escape — this is
/// intentional. The system fails SAFE: the guardian's instant `removeSolver`
/// keeps working, so capability can always be REDUCED, never silently ADDED. A
/// guardian-only escape hatch is deliberately NOT provided because it would
/// defeat the timelock (the guardian could `setManager` to a puppet that then
/// instant-adds solvers). Mitigation lives in the migration runbook: assert the
/// timelock has a live proposer + executor and `getMinDelay() >= 24h` BEFORE
/// installing this guardian.
contract AllowListGuardian {
    /// @dev The GPv2AllowListAuthentication proxy this guardian manages.
    IGPv2AllowListAuthentication public immutable authenticator;

    /// @dev The timelock (OZ TimelockController) authorised for SLOW ops.
    address public immutable timelock;

    /// @dev The guardian (protocol Safe) authorised for the FAST defensive
    /// `removeSolver` path. Rotatable only via the timelock so a compromised
    /// guardian cannot entrench itself.
    address public guardian;

    event GuardianChanged(address indexed newGuardian, address indexed oldGuardian);
    /// @dev Local events on every forwarded op so monitoring/alerting can watch
    /// this guardian directly — especially the time-sensitive instant eviction.
    event SolverAddedViaTimelock(address indexed solver);
    event SolverRemovedByGuardian(address indexed solver, address indexed by);
    event ManagerForwardedViaTimelock(address indexed newManager);

    modifier onlyTimelock() {
        require(msg.sender == timelock, "Guardian: caller not timelock");
        _;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, "Guardian: caller not guardian");
        _;
    }

    constructor(address authenticator_, address timelock_, address guardian_) {
        require(
            authenticator_ != address(0) && timelock_ != address(0) && guardian_ != address(0),
            "Guardian: zero address"
        );
        authenticator = IGPv2AllowListAuthentication(authenticator_);
        timelock = timelock_;
        guardian = guardian_;
        emit GuardianChanged(guardian_, address(0));
    }

    // ─── SLOW path (timelock, >= 24h) ────────────────────────────────────

    /// @notice Add an allowlisted solver. Only the timelock; subject to its
    /// full scheduling delay.
    function addSolver(address solver) external onlyTimelock {
        emit SolverAddedViaTimelock(solver);
        authenticator.addSolver(solver);
    }

    /// @notice Hand the authenticator `manager()` role to a new address (e.g.
    /// to migrate governance again). Only the timelock.
    function setManager(address newManager) external onlyTimelock {
        // A fat-fingered address(0) here would brick the authenticator's
        // manager role entirely; reject it (free, and timelock-fat-finger-safe).
        require(newManager != address(0), "Guardian: zero manager");
        emit ManagerForwardedViaTimelock(newManager);
        authenticator.setManager(newManager);
    }

    /// @notice Rotate the fast-path guardian (the Safe). Only the timelock, so
    /// the change is announced and delayed.
    function setGuardian(address newGuardian) external onlyTimelock {
        require(newGuardian != address(0), "Guardian: zero guardian");
        emit GuardianChanged(newGuardian, guardian);
        guardian = newGuardian;
    }

    // ─── FAST path (guardian / Safe, instant) ────────────────────────────

    /// @notice Remove an allowlisted solver immediately. Defensive only
    /// (capability-reducing), so it is not timelocked.
    function removeSolver(address solver) external onlyGuardian {
        emit SolverRemovedByGuardian(solver, msg.sender);
        authenticator.removeSolver(solver);
    }
}
