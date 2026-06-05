// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.7.6 <0.9.0;

/// @dev Minimal interface to the GPv2AllowListAuthentication functions this
/// guardian forwards to. The guardian becomes the authenticator's `manager()`.
interface IGPv2AllowListAuthentication {
    function addSolver(address solver) external;

    function removeSolver(address solver) external;

    function setManager(address manager) external;

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
        authenticator.addSolver(solver);
    }

    /// @notice Hand the authenticator `manager()` role to a new address (e.g.
    /// to migrate governance again). Only the timelock.
    function setManager(address newManager) external onlyTimelock {
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
        authenticator.removeSolver(solver);
    }
}
