// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

interface IElfomoTest {
    function getAmountOut(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256);
    function swap(
        address fromToken,
        address toToken,
        int256 specifiedAmount,
        uint256 limitAmount,
        address receiver,
        uint256 partnerId
    ) external;
}

interface IElfomoTokenTest {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ElfomoForkTest is Test {
    address constant ROUTER = 0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73;
    address constant SUBMITTER = 0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665;
    address constant SETTLEMENT = 0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function setUp() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC"), 93311122);
        assertEq(block.chainid, 4663);
        // Foundry lacks Nitro's ArbSys precompile; this is its real response at this pinned block.
        vm.mockCall(address(0x64), abi.encodeWithSignature("arbBlockNumber()"), abi.encode(uint256(93311122)));
    }

    function testElfomoSettlementBothDirections() public {
        uint256 received = _swap(WETH, USDG, 0.0001 ether);
        _swap(USDG, WETH, received);
    }

    function testElfomoRejectsUnattainableOutput() public {
        deal(WETH, SETTLEMENT, 0.0001 ether);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IElfomoTokenTest(WETH).approve(ROUTER, 0.0001 ether));
        vm.expectRevert();
        IElfomoTest(ROUTER).swap(WETH, USDG, 0.0001 ether, type(uint256).max, SETTLEMENT, 0);
        vm.stopPrank();
        assertEq(IElfomoTokenTest(WETH).balanceOf(SETTLEMENT), 0.0001 ether);
    }

    function _swap(address sell, address buy, uint256 amount) internal returns (uint256) {
        vm.prank(SETTLEMENT, SETTLEMENT);
        uint256 quoted = IElfomoTest(ROUTER).getAmountOut(sell, buy, amount);
        assertGt(quoted, 0);
        uint256 floor = quoted * 99 / 100;
        deal(sell, SETTLEMENT, amount);
        uint256 beforeOut = IElfomoTokenTest(buy).balanceOf(SETTLEMENT);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IElfomoTokenTest(sell).approve(ROUTER, amount));
        IElfomoTest(ROUTER).swap(sell, buy, int256(amount), floor, SETTLEMENT, 0);
        vm.stopPrank();
        uint256 received = IElfomoTokenTest(buy).balanceOf(SETTLEMENT) - beforeOut;
        assertGe(received, floor);
        assertEq(IElfomoTokenTest(sell).balanceOf(SETTLEMENT), 0);
        return received;
    }
}
