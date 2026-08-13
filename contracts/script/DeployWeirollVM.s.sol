// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console} from "forge-std/Script.sol";

/// @title Deploy the weiroll VM (Across bridge-source dependency)
///
/// The cow-sdk weiroll package hardcodes WEIROLL_ADDRESS = 0x9585c3...5963 as a
/// single chain-independent constant, and the Across deposit post-hook
/// DELEGATECALLs it. So bridging FROM a chain requires this VM deployed at
/// exactly that address; it was the missing fourth chain-local dependency
/// behind the 2026-08-13 incident (a delegatecall to a codeless target returns
/// success, so the deposit silently no-ops and funds strand in the CoW Shed).
///
/// Method: byte-exact CREATE2 replay of the mainnet creation bytecode
/// (script/weiroll/WeirollVM.initcode, see that folder's README) through the
/// standard deterministic proxy with salt 0 - compiler-independent, so no drift
/// can change the address. No constructor args (the VM stores its own address
/// as an immutable at construction, so the initcode is chain-agnostic).
///
/// Usage (key via --private-key per repo convention):
///   # dry-run (asserts predicted == canonical, deploys nothing):
///   forge script DeployWeirollVM --rpc-url $RPC --sender $EOA
///   # live:
///   WVM_CONFIRM=1 forge script DeployWeirollVM --rpc-url $RPC \
///     --private-key $PRIVATE_KEY --broadcast --slow
contract DeployWeirollVM is Script {
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = bytes32(0);
    address internal constant EXPECTED_VM = 0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963;

    function run() public {
        require(CREATE2_PROXY.code.length > 0, "DeployWeirollVM: CREATE2 proxy absent on this chain");

        bytes memory initcode = vm.parseBytes(vm.readFile("script/weiroll/WeirollVM.initcode"));
        require(
            vm.computeCreate2Address(SALT, keccak256(initcode), CREATE2_PROXY) == EXPECTED_VM,
            "DeployWeirollVM: initcode does not reproduce the canonical weiroll VM address"
        );

        console.log("chainid", block.chainid);
        console.log("weiroll VM", EXPECTED_VM, EXPECTED_VM.code.length > 0 ? "(present)" : "(absent)");

        if (EXPECTED_VM.code.length > 0) {
            console.log("already deployed - nothing to do.");
            return;
        }
        if (!_confirmed()) {
            console.log("DRY RUN: set WVM_CONFIRM=1 and pass --broadcast to deploy.");
            return;
        }

        // Refuse to broadcast off the Across source chains that actually need the
        // VM (the proxy exists on nearly every chain, so a stale --rpc-url would
        // otherwise bill gas on the wrong network). Add a chain id here only
        // alongside enabling it as an Across source.
        require(
            block.chainid == 57073 || block.chainid == 59144 || block.chainid == 130 || block.chainid == 4663,
            "DeployWeirollVM: confirmed deploy only on Ink/Linea/Unichain/Robinhood - check --rpc-url"
        );

        vm.broadcast();
        (bool ok,) = CREATE2_PROXY.call(bytes.concat(SALT, initcode));
        require(ok, "DeployWeirollVM: CREATE2 deploy call reverted");
        require(EXPECTED_VM.code.length > 0, "DeployWeirollVM: no code at the canonical address after deploy");
        console.log("deployed weiroll VM", EXPECTED_VM);
    }

    function _confirmed() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("WVM_CONFIRM", string("")))) == keccak256(bytes("1"));
    }
}
