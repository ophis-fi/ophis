// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

/// Drift guard for the weiroll VM redeploy artifact. The address is hardcoded
/// chain-independently in the SDK (WEIROLL_ADDRESS) and DELEGATECALLed by the
/// Across deposit hook, so the committed initcode MUST reproduce it exactly.
contract DeployWeirollVMTest is Test {
    address constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = bytes32(0);
    address constant EXPECTED_VM = 0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963;
    bytes32 constant EXPECTED_INITCODE_HASH = 0xe75ac6f040cd215056d2bc738bcd01734bd61386858d685a8d95084e87bc66ed;

    function test_initcodeReproducesCanonicalAddress() public view {
        bytes memory initcode = vm.parseBytes(vm.readFile("script/weiroll/WeirollVM.initcode"));
        assertEq(keccak256(initcode), EXPECTED_INITCODE_HASH, "initcode hash drift");
        assertEq(vm.computeCreate2Address(SALT, keccak256(initcode), CREATE2_PROXY), EXPECTED_VM, "address drift");
    }
}
