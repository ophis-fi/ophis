// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.7.6 <0.9.0;

import "../src/contracts/GPv2AllowListAuthentication.sol";

/// @dev Echidna harness for GPv2AllowListAuthentication.
///
/// Properties covered:
///   prop_allowlist_only_manager   — only manager may add/remove solvers
///   prop_no_phantom_manager_promotion — the manager slot only changes via
///       setManager from the manager itself or the EIP-1967 admin
///
/// Echidna calls all `external/public` functions as arbitrary senders. The
/// `echidna_*` functions are the invariants — Echidna calls them after
/// every call sequence and aborts on `false`.
///
/// Defaults:
///   - Echidna treats msg.sender as `0x10000`, `0x20000`, `0x30000` in
///     turn (configurable). None of these match `INITIAL_MANAGER`, so any
///     successful addSolver/removeSolver via the public ABI must mean a
///     bug — unless the harness explicitly grants manager.
contract E2EAllowList is GPv2AllowListAuthentication {
    address constant INITIAL_MANAGER = address(0xCAFE);
    // Echidna's default senders. Burn three slots so we can detect any
    // unauthorized state change. None of these are the manager.
    address constant SENDER_A = address(0x10000);
    address constant SENDER_B = address(0x20000);
    address constant SENDER_C = address(0x30000);

    // Track the original manager so the invariant can detect drift.
    address public originalManager;

    constructor() {
        // Mirror production deployment: the contract is deployed behind a
        // proxy with NO constructor on the logic side, and the proxy
        // immediately calls `initializeManager` exactly once. We replicate
        // that by writing the storage manually (constructor cannot call
        // `this.initializeManager` — the contract is not yet deployed)
        // AND consuming the Initializable._initialized slot via storage
        // slot 0 of Initializable.
        // Storage layout (inherited order): slot 0 packs Initializable's
        // _initialized (byte 0) + _initializing (byte 1) AND
        // GPv2AllowListAuthentication.manager (address, bytes 2..21 — it fits
        // in the remaining 30 bytes of slot 0). pendingManager and solvers
        // occupy later slots.
        //
        // ORDER MATTERS: set _initialized via a raw `sstore(0, 1)` FIRST, then
        // write `manager`. The packed `manager =` assignment is a
        // read-modify-write of slot 0, so it preserves the _initialized byte.
        // (Doing it the other way — manager first, then `sstore(0, 1)` — wrote
        // the WHOLE slot 0 to 1, zeroing the packed `manager` field, so
        // echidna_manager_unchanged failed at construction with no txs.)
        // _initialized = true so Echidna cannot call initializeManager and
        // legitimately reassign the manager.
        assembly {
            sstore(0, 1)
        }
        manager = INITIAL_MANAGER;
        originalManager = INITIAL_MANAGER;
        emit ManagerChanged(INITIAL_MANAGER, address(0));
    }

    // ---------------- invariants ----------------

    /// @dev prop_allowlist_only_manager: solvers set should remain unchanged
    /// from the empty state, because none of Echidna's senders match
    /// INITIAL_MANAGER. If any address appears as a solver, an unauthorized
    /// addSolver succeeded.
    function echidna_no_solver_added_by_non_manager() public view returns (bool) {
        if (this.isSolver(SENDER_A)) return false;
        if (this.isSolver(SENDER_B)) return false;
        if (this.isSolver(SENDER_C)) return false;
        if (this.isSolver(address(0))) return false;
        if (this.isSolver(address(this))) return false;
        return true;
    }

    /// @dev prop_no_phantom_manager_promotion: manager only changes if the
    /// existing manager or proxy admin calls setManager. Echidna's senders
    /// are not the manager nor the EIP-1967 admin (proxy admin slot is
    /// uninitialized — `getAdmin` returns address(0), which equals
    /// `msg.sender` only for system calls Echidna can't produce).
    function echidna_manager_unchanged() public view returns (bool) {
        return manager == originalManager;
    }
}
