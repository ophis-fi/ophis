// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;
import {Test} from "forge-std/Test.sol";

interface IFxCurveTest {
    function coins(uint256 i) external view returns (address);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

interface IFxCurveTokenTest {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract FxCurveForkTest is Test {
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address constant SUBMITTER = 0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665;
    address constant MAIN_POOL = 0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f;

    function setUp() public {
        vm.createSelectFork(vm.envString("ETHEREUM_RPC"), 26232714);
        assertEq(block.chainid, 1);
    }

    function testAllPublishedFxCurvePoolsBothDirections() public {
        // Pool addresses from f(x)'s published deployment list, independently of the Rust catalog.
        address[16] memory pools = [
            0x8fFC7b89412eFD0D17EDEa2018F6634eA4C2FCb2,
            0xd6982da59F1D26476E259559508f4135135cf9b8,
            0x189B4e49B5cAf33565095097b4B960F14032C7D0,
            0x69Cf42F15F9325986154b61A013da6E8feC82CCF,
            0x1EE81c56e42EC34039D993d12410d437DdeA341E,
            0x74345504Eaea3D9408fC69Ae7EB2d14095643c5b,
            0x16b54e3aC8e3ba088333985035b869847e36E770,
            0xcA554E2e2948a211D4650Fe0F4E271f01f9cB5F1,
            0xF33aB11E5C4e55DAcB13644f0C0A9d1e199A796F,
            0x6fC7eA6CA8Cd2759803eb78159C931a8FF5E0557,
            0x2116BFaD62b383043230501f6a124c6EA60CcfA5,
            0x27cB9629aE3Ee05cb266B99cA4124EC999303c9D,
            0xD7Bf9bb6Bd088317Effd116E2B70ea3A054cBceb,
            0x13eA95Ce68185e334d3747539845A3b7643a8cab,
            0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f,
            0x74c204520c9e88aA3EB9d61788ABA11Be1e0193F
        ];
        for (uint256 k; k < pools.length; k++) {
            _swap(pools[k], 0, 1);
            _swap(pools[k], 1, 0);
        }
    }

    function testFxCurveMinimumOutputRevertsWithoutSpending() public {
        address sell = IFxCurveTest(MAIN_POOL).coins(0);
        uint256 amount = 10 ** IFxCurveTokenTest(sell).decimals();
        deal(sell, SETTLEMENT, amount + 17);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IFxCurveTokenTest(sell).approve(MAIN_POOL, amount));
        vm.expectRevert();
        IFxCurveTest(MAIN_POOL).exchange(0, 1, amount, type(uint256).max);
        vm.stopPrank();
        assertEq(IFxCurveTokenTest(sell).balanceOf(SETTLEMENT), amount + 17);
    }

    function _swap(address pool, int128 i, int128 j) internal {
        address sell = IFxCurveTest(pool).coins(uint256(uint128(i)));
        address buy = IFxCurveTest(pool).coins(uint256(uint128(j)));
        uint256 amount = 10 ** IFxCurveTokenTest(sell).decimals();
        uint256 quoted = IFxCurveTest(pool).get_dy(i, j, amount);
        assertGt(quoted, 0);
        uint256 floor = quoted * 99 / 100;
        deal(sell, SETTLEMENT, amount + 17);
        uint256 beforeOut = IFxCurveTokenTest(buy).balanceOf(SETTLEMENT);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IFxCurveTokenTest(sell).approve(pool, amount));
        uint256 reported = IFxCurveTest(pool).exchange(i, j, amount, floor);
        vm.stopPrank();
        uint256 received = IFxCurveTokenTest(buy).balanceOf(SETTLEMENT) - beforeOut;
        assertEq(received, reported);
        assertGe(received, floor);
        assertEq(IFxCurveTokenTest(sell).balanceOf(SETTLEMENT), 17);
    }
}
