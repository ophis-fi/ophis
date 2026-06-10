// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.7.6 <0.9.0;

import "./interfaces/GPv2Authentication.sol";
import "./libraries/GPv2EIP1967.sol";
import "./mixins/Initializable.sol";
import "./mixins/StorageAccessible.sol";

/// @title Gnosis Protocol v2 Access Control Contract
/// @author Gnosis Developers
contract GPv2AllowListAuthentication is
    GPv2Authentication,
    Initializable,
    StorageAccessible
{
    /// @dev The address of the manager that has permissions to add and remove
    /// solvers.
    address public manager;

    /// @dev The set of allowed solvers. Allowed solvers have a value of `true`
    /// in this mapping.
    mapping(address => bool) private solvers;

    /// @dev MED-1 (2026-05-22 ToB-suite audit hardening): the proposed next
    /// manager from a two-step transfer initiated via `proposeManager`. The
    /// proposed manager must call `acceptManagership` to complete the
    /// transfer; until then `manager` remains unchanged. Cleared on
    /// acceptance or cancellation. Default `address(0)` = no pending
    /// transfer.
    ///
    /// Storage layout invariant (verified via the live deployment artifact
    /// at `deployments/optimism-mainnet/GPv2AllowListAuthentication_Implementation.json`
    /// — Codex Cyber PR #224 review):
    ///   slot 0, offset 0: `_initialized` (uint8 from Initializable)
    ///   slot 0, offset 1: `_initializing` (bool from Initializable)
    ///   slot 0, offset 2: `manager` (address, 20 bytes — packs into slot 0)
    ///   slot 1: `solvers` mapping seed
    ///   slot 2: `pendingManager` (NEW, appended at next-available slot)
    /// Existing live storage at slots 0-1 is byte-identical post-upgrade;
    /// slot 2 reads as `address(0)` until the first `proposeManager` call.
    address public pendingManager;

    /// @dev Event emitted when the manager changes.
    event ManagerChanged(address newManager, address oldManager);

    /// @dev MED-1: event emitted when a two-step manager transfer is
    /// PROPOSED via `proposeManager`. The proposed manager must call
    /// `acceptManagership` to complete the transfer. `ManagerChanged`
    /// fires on acceptance.
    event ManagerTransferProposed(address pendingManager, address currentManager);

    /// @dev MED-1: event emitted when a two-step manager transfer is
    /// CANCELLED via `cancelManagerTransfer`. The cancelled address is
    /// emitted for indexer convenience.
    event ManagerTransferCancelled(address cancelledPendingManager);

    /// @dev Event emitted when a solver gets added.
    event SolverAdded(address solver);

    /// @dev Event emitted when a solver gets removed.
    event SolverRemoved(address solver);

    /// @dev Initialize the manager to a value.
    ///
    /// This method is a contract initializer that is called exactly once after
    /// creation. An initializer is used instead of a constructor so that this
    /// contract can be used behind a proxy.
    ///
    /// This initializer is idempotent.
    ///
    /// @param manager_ The manager to initialize the contract with.
    function initializeManager(address manager_) external initializer {
        manager = manager_;
        emit ManagerChanged(manager_, address(0));
    }

    /// @dev Modifier that ensures a method can only be called by the contract
    /// manager. Reverts if called by other addresses.
    modifier onlyManager() {
        require(manager == msg.sender, "GPv2: caller not manager");
        _;
    }

    /// @dev Modifier that ensures method can be either called by the contract
    /// manager or the proxy owner.
    ///
    /// This modifier assumes that the proxy uses an EIP-1967 compliant storage
    /// slot for the admin.
    modifier onlyManagerOrOwner() {
        require(
            manager == msg.sender || GPv2EIP1967.getAdmin() == msg.sender,
            "GPv2: not authorized"
        );
        _;
    }

    /// @dev Set the manager for this contract.
    ///
    /// This method can be called by the current manager (if they want to to
    /// relinquish the role and give it to another address) or the contract
    /// owner (i.e. the proxy admin).
    ///
    /// **WARNING — single-step transfer (typo-risk)**: this function changes
    /// the manager INSTANTLY. A typo in `manager_` permanently locks
    /// solver-allowlist control. For typo-resistant transfers, prefer
    /// `proposeManager` + `acceptManagership` (MED-1, two-step pattern).
    /// `setManager` is retained for backwards compatibility + the
    /// emergency-rescue path when the proxy admin needs to override a
    /// non-responsive manager without waiting for acceptance.
    ///
    /// @param manager_ The new contract manager address.
    function setManager(address manager_) external onlyManagerOrOwner {
        address oldManager = manager;
        manager = manager_;
        // Defense-in-depth: clear any pending two-step transfer when an
        // immediate setManager fires. Avoids the confusing state where
        // setManager was used to rescue but `pendingManager` still
        // dangles from an earlier `proposeManager` call.
        if (pendingManager != address(0)) {
            address cancelled = pendingManager;
            delete pendingManager;
            emit ManagerTransferCancelled(cancelled);
        }
        emit ManagerChanged(manager_, oldManager);
    }

    /// @dev MED-1 (2026-05-22 ToB-suite audit): two-step manager transfer —
    /// step 1 of 2. Propose a new manager. The proposed address must call
    /// `acceptManagership` to complete the transfer. Until then, `manager`
    /// is unchanged.
    ///
    /// Typo-resistant: if `manager_` is a typo (no one controls that
    /// address), the proposal cannot be accepted and the current manager
    /// remains in control. The proposal can be cancelled or overwritten by
    /// the current manager (or proxy admin) via `cancelManagerTransfer` or
    /// by calling `proposeManager` again with a different address.
    ///
    /// @param manager_ The address proposed as the next manager.
    function proposeManager(address manager_) external onlyManagerOrOwner {
        pendingManager = manager_;
        emit ManagerTransferProposed(manager_, manager);
    }

    /// @dev MED-1: two-step manager transfer — step 2 of 2. Accept the
    /// pending manager role. Only callable by the address previously
    /// proposed via `proposeManager`.
    ///
    /// On success: `manager` is updated, `pendingManager` is cleared, and
    /// `ManagerChanged` fires (matching the same event the single-step
    /// `setManager` emits). The caller is now the manager.
    function acceptManagership() external {
        require(pendingManager != address(0), "GPv2: no pending manager");
        require(msg.sender == pendingManager, "GPv2: caller not pending manager");
        address oldManager = manager;
        manager = pendingManager;
        delete pendingManager;
        emit ManagerChanged(manager, oldManager);
    }

    /// @dev MED-1: cancel a pending two-step manager transfer. Callable by
    /// the current manager or the proxy admin. No-op if no pending
    /// transfer exists (but still emits the event with `address(0)` for
    /// log-symmetry).
    function cancelManagerTransfer() external onlyManagerOrOwner {
        address cancelled = pendingManager;
        delete pendingManager;
        emit ManagerTransferCancelled(cancelled);
    }

    /// @dev Add an address to the set of allowed solvers. This method can only
    /// be called by the contract manager.
    ///
    /// This function is idempotent.
    ///
    /// @param solver The solver address to add.
    function addSolver(address solver) external onlyManager {
        solvers[solver] = true;
        emit SolverAdded(solver);
    }

    /// @dev Removes an address to the set of allowed solvers. This method can
    /// only be called by the contract manager.
    ///
    /// This function is idempotent.
    ///
    /// @param solver The solver address to remove.
    function removeSolver(address solver) external onlyManager {
        solvers[solver] = false;
        emit SolverRemoved(solver);
    }

    /// @inheritdoc GPv2Authentication
    function isSolver(
        address prospectiveSolver
    ) external view override returns (bool) {
        return solvers[prospectiveSolver];
    }
}
