// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console} from "forge-std/Script.sol";

import {AcrossMathHelper} from "../src/contracts/AcrossMathHelper.sol";

/// @title Deploy AcrossMathHelper (deterministic)
///
/// Deploys the Across weiroll math helper so a new chain can be an Across bridge
/// SOURCE (initial targets: Ink 57073, Linea 59144). The contract is pure math
/// with no constructor args, owner, or funds, so - unlike the FeeLiquidator
/// deploy - there is no immutable-owner footgun; the only care needed is a
/// DETERMINISTIC address so the frontend SDK patch can register it in advance
/// and every chain shares one address.
///
/// Determinism: the helper is deployed with CREATE2 through Foundry's default
/// deterministic-deployment proxy (0x4e59b44847b379578588920cA78FbF26c0B4956C),
/// so the resulting address is a pure function of (proxy, SALT, initcode) and is
/// independent of the deployer EOA. `test/AcrossMathHelper.t.sol` fork-proves
/// the deployed bytecode is output-equivalent to the canonical mainnet helper.
///
/// Predicted address (verify with the dry-run below before wiring the patch):
///   run `forge script DeployAcrossMathHelper --rpc-url $RPC` and read the
///   logged `predicted` value; it MUST equal the value registered in the
///   frontend sdk-bridging pnpm patch (ACROSS_MATH_CONTRACT_ADDRESSES).
///
/// Usage:
///   # dry-run (no broadcast; logs the predicted address + whether it exists):
///   forge script DeployAcrossMathHelper --rpc-url $INK_RPC --sender $EOA
///   # live (only after reviewing the dry-run):
///   AMH_CONFIRM=1 PRIVATE_KEY=… \
///     forge script DeployAcrossMathHelper --rpc-url $INK_RPC --broadcast
contract DeployAcrossMathHelper is Script {
    // Namespaced salt: keeps the address distinct from any unrelated CREATE2
    // deploy of the same initcode while staying identical across every chain we
    // deploy to. Changing this string changes the address - do not.
    bytes32 internal constant SALT = keccak256("ophis.AcrossMathHelper.v1");
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() public returns (AcrossMathHelper helper) {
        bytes32 initcodeHash = keccak256(type(AcrossMathHelper).creationCode);
        address predicted = vm.computeCreate2Address(SALT, initcodeHash, CREATE2_PROXY);

        console.log("chainid  ", block.chainid);
        console.log("salt     ", vm.toString(SALT));
        console.log("initcode ", vm.toString(initcodeHash));
        console.log("predicted", predicted);
        console.log("hasCode  ", predicted.code.length > 0);

        // The deterministic proxy must exist on the target chain, else the
        // CREATE2 deploy silently no-ops to a plain send. It is present on Ink
        // and Linea (and most chains) via Nick's method.
        require(CREATE2_PROXY.code.length > 0, "DeployAcrossMathHelper: CREATE2 proxy absent on this chain");

        if (predicted.code.length > 0) {
            console.log("Already deployed at the deterministic address - nothing to do.");
            return AcrossMathHelper(predicted);
        }

        if (!_confirmed()) {
            console.log("DRY RUN: set AMH_CONFIRM=1 and pass --broadcast to deploy.");
            return AcrossMathHelper(predicted);
        }

        vm.startBroadcast();
        helper = new AcrossMathHelper{salt: SALT}();
        vm.stopBroadcast();

        require(address(helper) == predicted, "DeployAcrossMathHelper: deployed address != predicted");
        console.log("Deployed ", address(helper));
    }

    function _confirmed() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("AMH_CONFIRM", string("")))) == keccak256(bytes("1"));
    }
}
