// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

import {OphisVaultPolicyModule} from "./OphisVaultPolicyModule.sol";

/// @title Factory for Ophis vault order-policy modules
/// @notice Deploys one immutable policy module per vault and enforces, AT
/// DEPLOY TIME, the operational invariant the module's guarantee rests on:
/// the curator must not be a Safe owner (an owner-curator could bypass the
/// module entirely by executing raw approve/setPreSignature as the Safe).
/// The module constructor separately probes every configured Chainlink feed
/// (fail-closed liveness), so a deploy through this factory yields a module
/// whose whole policy surface has been validated on-chain.
///
/// After deploy the vault OWNERS must still enable the module on the Safe
/// (`enableModule`) and scope the curator key (Zodiac Roles) to call ONLY
/// `module.rebalance` / `module.cancel` - keeping the curator un-ownered
/// over time remains the owners' responsibility.
contract OphisVaultPolicyModuleFactory {
    event ModuleDeployed(
        address indexed module,
        address indexed safe,
        address indexed curator,
        address settlement
    );

    error CuratorIsSafeOwner(address curator);

    function deploy(
        OphisVaultPolicyModule.ModuleConfig calldata cfg
    ) external returns (OphisVaultPolicyModule module) {
        // The one check the module itself cannot self-enforce cheaply on
        // every call: a curator that is (or becomes) a Safe owner has full
        // Safe power and does not need the module. Reject at deploy;
        // owner-set drift afterwards is governance's to prevent.
        address[] memory owners = cfg.safe.getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == cfg.curator) revert CuratorIsSafeOwner(cfg.curator);
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
