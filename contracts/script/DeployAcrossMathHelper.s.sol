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
/// Usage (matches contracts/README.md: key passed to Forge with --private-key,
/// not an env var — vm.startBroadcast() does not read PRIVATE_KEY):
///   # dry-run (no broadcast; logs the predicted address + whether it exists):
///   forge script DeployAcrossMathHelper --rpc-url $INK_RPC --sender $EOA
///   # live (only after reviewing the dry-run):
///   AMH_CONFIRM=1 \
///     forge script DeployAcrossMathHelper --rpc-url $INK_RPC --private-key $PRIVATE_KEY --broadcast --slow
contract DeployAcrossMathHelper is Script {
    // Namespaced salt: keeps the address distinct from any unrelated CREATE2
    // deploy of the same initcode while staying identical across every chain we
    // deploy to. Changing this string changes the address - do not.
    bytes32 internal constant SALT = keccak256("ophis.AcrossMathHelper.v1");
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // The address registered in the frontend sdk-bridging patch
    // (ACROSS_MATH_CONTRACT_ADDRESSES for INK/LINEA). The deploy MUST land here
    // or the frontend would call a codeless address, so we assert on it rather
    // than only self-comparing the deployed vs freshly-predicted address.
    address internal constant EXPECTED_HELPER = 0xEdE97D044d4C8aAA682968bee10284521B9f311a;

    function run() public returns (AcrossMathHelper helper) {
        bytes32 initcodeHash = keccak256(type(AcrossMathHelper).creationCode);
        address predicted = vm.computeCreate2Address(SALT, initcodeHash, CREATE2_PROXY);

        console.log("chainid  ", block.chainid);
        console.log("salt     ", vm.toString(SALT));
        console.log("initcode ", vm.toString(initcodeHash));
        console.log("predicted", predicted);
        console.log("expected ", EXPECTED_HELPER);
        console.log("hasCode  ", predicted.code.length > 0);

        // Bind the deploy to the address the frontend was patched with. If the
        // compiler or foundry.toml optimizer/evm settings ever drift, the
        // creation bytecode changes, predicted diverges from EXPECTED_HELPER, and
        // this reverts on BOTH the dry-run and the broadcast - so we can never
        // deploy code the frontend will not call.
        require(
            predicted == EXPECTED_HELPER,
            "DeployAcrossMathHelper: predicted != registered address (compiler/settings drift)"
        );

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

        // Refuse to broadcast off the chains that register this helper. The
        // CREATE2 proxy exists on nearly every chain, so without this a stale
        // --rpc-url would deploy on the wrong network while the registered chain
        // stays empty. This set must equal the chains the frontend sdk-bridging
        // patch registers in ACROSS_MATH_CONTRACT_ADDRESSES (Ink/Linea/Unichain/
        // Robinhood) - add a chain here only alongside registering it there.
        require(
            block.chainid == 57073 || block.chainid == 59144 || block.chainid == 130 || block.chainid == 4663,
            "DeployAcrossMathHelper: confirmed deploy only on Ink/Linea/Unichain/Robinhood - check --rpc-url"
        );

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
