// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

/// Drift guard for the CoW Shed redeploy artifacts. The canonical addresses are
/// hardcoded downstream (the SDK's COW_SHED_FACTORY), so the committed initcode
/// MUST reproduce them exactly. If either artifact is corrupted or swapped, the
/// CREATE2 address changes and this fails - before any deploy.
contract DeployCowShedTest is Test {
    address constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = bytes32(0);
    address constant EXPECTED_IMPL = 0xa2704cF562AD418Bf0453F4B662ebf6A2489eD88;
    address constant EXPECTED_FACTORY = 0x312f92fe5f1710408B20D52A374fa29e099cFA86;

    function test_initcodeReproducesCanonicalAddresses() public view {
        bytes memory implInit = vm.parseBytes(vm.readFile("script/cowshed/COWShed.initcode"));
        bytes memory factoryInit = vm.parseBytes(vm.readFile("script/cowshed/COWShedFactory.initcode"));

        assertEq(vm.computeCreate2Address(SALT, keccak256(implInit), CREATE2_PROXY), EXPECTED_IMPL, "impl");
        assertEq(vm.computeCreate2Address(SALT, keccak256(factoryInit), CREATE2_PROXY), EXPECTED_FACTORY, "factory");

        // The factory clones the impl, so its initcode must embed the impl
        // address (as the constructor arg / immutable). Guards against pairing a
        // factory artifact with a mismatched implementation.
        assertTrue(_contains(factoryInit, abi.encodePacked(EXPECTED_IMPL)), "factory must reference the impl");
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || hay.length < needle.length) return false;
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
