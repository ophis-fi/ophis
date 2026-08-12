// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {AcrossMathHelper} from "../src/contracts/AcrossMathHelper.sol";

interface IMultiplyAndSubtract {
    function multiplyAndSubtract(uint256 _a, uint256 _b) external pure returns (uint256);
}

/// @dev The canonical helper CoW/Across run on Ethereum mainnet. Our deploy on
/// new source chains must be output-equivalent to it, proven by fork below.
address constant MAINNET_HELPER = 0xf2ae6728b6f146556977Af0A68bFbf5bADA22863;
uint256 constant ONE = 1e18;

contract AcrossMathHelperTest is Test {
    AcrossMathHelper internal helper;

    function setUp() public {
        helper = new AcrossMathHelper();
    }

    /// The selector weiroll dispatches to must be exactly the mainnet one.
    function test_selectorMatchesCanonical() public pure {
        assertEq(AcrossMathHelper.multiplyAndSubtract.selector, bytes4(0x029beb8e));
    }

    /// Drift guard: the deterministic CREATE2 address must stay the one
    /// registered in the frontend sdk-bridging patch and asserted in
    /// DeployAcrossMathHelper (EXPECTED_HELPER). It is baked into the creation
    /// bytecode (metadata hash), so editing this contract's source shifts it -
    /// this fails immediately, before any deploy, if that happens. If you change
    /// the contract, recompute and update the address in all three places.
    function test_deterministicAddressMatchesRegistered() public pure {
        address predicted = vm.computeCreate2Address(
            keccak256("ophis.AcrossMathHelper.v1"),
            keccak256(type(AcrossMathHelper).creationCode),
            0x4e59b44847b379578588920cA78FbF26c0B4956C
        );
        assertEq(predicted, 0xEdE97D044d4C8aAA682968bee10284521B9f311a);
    }

    function test_zeroFeeReturnsInput() public view {
        assertEq(helper.multiplyAndSubtract(123_456 ether, 0), 123_456 ether);
    }

    function test_fullFeeReturnsZero() public view {
        assertEq(helper.multiplyAndSubtract(123_456 ether, ONE), 0);
    }

    function test_revertsAboveOneHundredPercent() public {
        vm.expectRevert("Fraction _b must not exceed 1e18 (100%)");
        helper.multiplyAndSubtract(1 ether, ONE + 1);
    }

    /// Rounding direction: the fee term floors, so the result rounds UP. With
    /// _a = 3 and _b = 1 (1e-18), the fee 3*1/1e18 floors to 0 -> result == _a.
    function test_feeTermFloorsResultRoundsUp() public view {
        assertEq(helper.multiplyAndSubtract(3, 1), 3);
    }

    /// Core invariants, independent of the implementation expression.
    function testFuzz_properties(uint256 a, uint256 b) public view {
        a = bound(a, 0, 1e30); // realistic token amounts; keeps a*b < 2^256
        b = bound(b, 0, ONE);

        uint256 result = helper.multiplyAndSubtract(a, b);
        uint256 fee = (a * b) / ONE;

        assertEq(result, a - fee, "result must equal a minus the floored fee");
        assertLe(result, a, "result never exceeds the input");
        if (b == 0) assertEq(result, a, "zero fee is a no-op");
        if (b == ONE) assertEq(result, 0, "full fee zeroes the output");
    }

    /// Gold-standard equivalence: our helper must return byte-identical results
    /// to the live mainnet contract for every input. Runs only when a mainnet
    /// RPC is configured (MAINNET_RPC_URL); skipped otherwise so the default
    /// unit run stays offline.
    function testFuzz_forkEquivalenceWithMainnet(uint256 a, uint256 b) public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        a = bound(a, 0, 1e30);
        b = bound(b, 0, ONE);

        // Redeploy on the fork so both live on the same chain state.
        AcrossMathHelper local = new AcrossMathHelper();
        uint256 mine = local.multiplyAndSubtract(a, b);
        uint256 canonical = IMultiplyAndSubtract(MAINNET_HELPER).multiplyAndSubtract(a, b);
        assertEq(mine, canonical, "diverges from the canonical mainnet helper");
    }
}
