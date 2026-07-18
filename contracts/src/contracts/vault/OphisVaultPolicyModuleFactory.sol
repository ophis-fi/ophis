// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

import {OphisVaultPolicyModule} from "./OphisVaultPolicyModule.sol";

/// @title Factory for Ophis vault order-policy modules
/// @notice Deploys one immutable policy module per vault and enforces, AT
/// DEPLOY TIME, the operational invariant the module's guarantee rests on:
/// the curator must be neither a Safe owner NOR an enabled Safe module (either
/// could bypass the module entirely by executing raw approve/setPreSignature as
/// the Safe). The module constructor separately probes every configured
/// Chainlink feed (fail-closed liveness), so a deploy through this factory
/// yields a module whose whole policy surface has been validated on-chain.
///
/// After deploy the vault OWNERS must still enable the module on the Safe
/// (`enableModule`). The curator is a DIRECT caller - a dedicated EOA / MPC
/// signer / multisig that calls ONLY `module.rebalance` / `module.cancel`. Do
/// NOT wrap it in a Zodiac Roles Modifier: Roles execs via the Safe avatar, so
/// the module would see `msg.sender == the Safe` and reject every call. Keeping
/// the curator un-ownered / un-moduled over time remains the owners'
/// responsibility.
contract OphisVaultPolicyModuleFactory {
    event ModuleDeployed(
        address indexed module,
        address indexed safe,
        address indexed curator,
        address settlement
    );

    error CuratorIsSafeOwner(address curator);
    error CuratorIsSafeModule(address curator);

    function deploy(
        OphisVaultPolicyModule.ModuleConfig calldata cfg
    ) external returns (OphisVaultPolicyModule module) {
        // The checks the module cannot cheaply self-enforce on every call: a
        // curator that is (or becomes) a Safe owner OR an already-enabled Safe
        // module has a privileged path to the Safe and does not need the module
        // gate. Reject both at deploy; owner/module-set drift afterwards is
        // governance's to prevent. (The module constructor re-checks both, so a
        // direct deploy cannot skip them.)
        address[] memory owners = cfg.safe.getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == cfg.curator) revert CuratorIsSafeOwner(cfg.curator);
        }
        if (cfg.safe.isModuleEnabled(cfg.curator)) {
            revert CuratorIsSafeModule(cfg.curator);
        }

        module = new OphisVaultPolicyModule(cfg);
        emit ModuleDeployed(
            address(module),
            address(cfg.safe),
            cfg.curator,
            address(cfg.settlement)
        );
    }
}
