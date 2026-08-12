// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console} from "forge-std/Script.sol";

/// @title Deploy CoW Shed factory + implementation (Ophis sovereign chains)
///
/// Bridging FROM an Ophis sovereign chain (Unichain 130, Robinhood Chain 4663)
/// needs the CoW Shed factory the cow-sdk bridging package hardcodes as
/// COW_SHED_FACTORY (0x312f92fe...CfA86) plus its implementation
/// (0xa2704cf5...9eD88). Both are absent on 130/4663 today. Their addresses are
/// settlement-INDEPENDENT (the factory ctor arg is the impl address, not a
/// settlement), so they are identical on every chain and reproducible
/// permissionlessly.
///
/// Method: byte-exact CREATE2 replay. We do NOT recompile the CoW Shed source -
/// that risks a metadata/compiler drift that would change the address - but
/// submit the EXACT creation bytecode CoW deployed on mainnet
/// (script/cowshed/*.initcode, see that folder's README) to the standard
/// deterministic CREATE2 proxy (0x4e59b44847...4956C, present on both chains)
/// with salt 0. This asserts CREATE2(proxy, 0, keccak(initcode)) == the
/// canonical address before broadcasting anything.
///
/// Order: the factory embeds the impl address, so the impl must exist first
/// (else the factory's proxies would clone a codeless implementation).
///
/// NOTE: this is only ONE piece of enabling a sovereign bridge source. The
/// source chain also needs a HooksTrampoline built against OPHIS's settlement
/// (settlement-specific, not this canonical address), the Ophis driver
/// configured to execute post-hooks through it, and a live E2E proof.
///
/// Usage (key via --private-key per repo convention, README.md):
///   # dry-run (asserts predicted == canonical, deploys nothing):
///   forge script DeployCowShed --rpc-url $UNICHAIN_RPC --sender $EOA
///   # live:
///   CSHED_CONFIRM=1 forge script DeployCowShed --rpc-url $UNICHAIN_RPC \
///     --private-key $PRIVATE_KEY --broadcast --slow
contract DeployCowShed is Script {
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = bytes32(0);
    address internal constant EXPECTED_IMPL = 0xa2704cF562AD418Bf0453F4B662ebf6A2489eD88;
    address internal constant EXPECTED_FACTORY = 0x312f92fe5f1710408B20D52A374fa29e099cFA86;

    function run() public {
        require(CREATE2_PROXY.code.length > 0, "DeployCowShed: CREATE2 proxy absent on this chain");

        bytes memory implInit = vm.parseBytes(vm.readFile("script/cowshed/COWShed.initcode"));
        bytes memory factoryInit = vm.parseBytes(vm.readFile("script/cowshed/COWShedFactory.initcode"));

        // Bind the deploy to the canonical addresses: a corrupted artifact
        // reverts here (dry-run AND broadcast) instead of deploying a wrong,
        // frontend-invisible address.
        require(
            vm.computeCreate2Address(SALT, keccak256(implInit), CREATE2_PROXY) == EXPECTED_IMPL,
            "DeployCowShed: impl initcode does not reproduce the canonical address"
        );
        require(
            vm.computeCreate2Address(SALT, keccak256(factoryInit), CREATE2_PROXY) == EXPECTED_FACTORY,
            "DeployCowShed: factory initcode does not reproduce the canonical address"
        );

        console.log("chainid", block.chainid);
        console.log("impl   ", EXPECTED_IMPL, EXPECTED_IMPL.code.length > 0 ? "(present)" : "(absent)");
        console.log("factory", EXPECTED_FACTORY, EXPECTED_FACTORY.code.length > 0 ? "(present)" : "(absent)");

        if (!_confirmed()) {
            console.log("DRY RUN: set CSHED_CONFIRM=1 and pass --broadcast to deploy.");
            return;
        }

        // Impl first: the factory clones it.
        _deployIfAbsent(implInit, EXPECTED_IMPL, "impl");
        _deployIfAbsent(factoryInit, EXPECTED_FACTORY, "factory");
    }

    function _deployIfAbsent(bytes memory initcode, address expected, string memory label) internal {
        if (expected.code.length > 0) {
            console.log("already deployed, skipping", label);
            return;
        }
        // The deterministic proxy CREATE2s `initcode` using the leading 32 bytes
        // of calldata as the salt.
        vm.broadcast();
        (bool ok,) = CREATE2_PROXY.call(bytes.concat(SALT, initcode));
        require(ok, "DeployCowShed: CREATE2 deploy call reverted");
        require(expected.code.length > 0, "DeployCowShed: no code at the canonical address after deploy");
        console.log("deployed", label, expected);
    }

    function _confirmed() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("CSHED_CONFIRM", string("")))) == keccak256(bytes("1"));
    }
}
