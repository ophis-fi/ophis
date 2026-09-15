// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {OphisHooklessUniswapV4Adapter} from "../../src/contracts/OphisHooklessUniswapV4Adapter.sol";

interface IERC20HooklessAdapterTest {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

contract UnichainV4Test is Test {
    address private constant POOL_MANAGER = 0x1F98400000000000000000000000000000000004;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant USDC = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;

    OphisHooklessUniswapV4Adapter private adapter;
    bool private forkEnabled;

    function setUp() external {
        string memory rpcUrl = vm.envString("UNICHAIN_RPC");
        forkEnabled = true;
        vm.createSelectFork(rpcUrl);
        adapter = new OphisHooklessUniswapV4Adapter(address(this), POOL_MANAGER, WETH, USDC, 500, 10);
    }

    function testSwapWethToUsdc() external {
        if (!forkEnabled) return;
        uint256 amountIn = 0.01 ether;
        deal(WETH, address(this), amountIn);
        IERC20HooklessAdapterTest(WETH).approve(address(adapter), amountIn);

        uint256 beforeBalance = IERC20HooklessAdapterTest(USDC).balanceOf(address(this));
        uint256 amountOut = adapter.swapExactInput(WETH, amountIn, 1);

        assertGt(amountOut, 1);
        assertEq(IERC20HooklessAdapterTest(USDC).balanceOf(address(this)) - beforeBalance, amountOut);
        assertEq(address(adapter).balance, 0);
        assertEq(IERC20HooklessAdapterTest(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20HooklessAdapterTest(USDC).balanceOf(address(adapter)), 0);
    }

    function testSwapUsdcToWeth() external {
        if (!forkEnabled) return;
        uint256 amountIn = 10e6;
        deal(USDC, address(this), amountIn);
        IERC20HooklessAdapterTest(USDC).approve(address(adapter), amountIn);

        uint256 beforeBalance = IERC20HooklessAdapterTest(WETH).balanceOf(address(this));
        uint256 amountOut = adapter.swapExactInput(USDC, amountIn, 1);

        assertGt(amountOut, 1);
        assertEq(IERC20HooklessAdapterTest(WETH).balanceOf(address(this)) - beforeBalance, amountOut);
        assertEq(address(adapter).balance, 0);
        assertEq(IERC20HooklessAdapterTest(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20HooklessAdapterTest(USDC).balanceOf(address(adapter)), 0);
    }

    function testOnlySettlementCanSwap() external {
        if (!forkEnabled) return;
        vm.prank(address(0xBAD));
        vm.expectRevert(OphisHooklessUniswapV4Adapter.Unauthorized.selector);
        adapter.swapExactInput(WETH, 1, 1);
    }

    function testFuzzOnlySettlementCanSwap(uint256 amountIn) external {
        if (!forkEnabled) return;
        vm.prank(address(0xBAD));
        vm.expectRevert(OphisHooklessUniswapV4Adapter.Unauthorized.selector);
        adapter.swapExactInput(WETH, amountIn, 1);
    }

    function testPoolManagerCallbackCannotBeForged() external {
        if (!forkEnabled) return;
        vm.expectRevert(OphisHooklessUniswapV4Adapter.InvalidCallback.selector);
        adapter.unlockCallback(abi.encode(true, 1 ether));
    }

    function testMinimumOutputRevertsAtomically() external {
        if (!forkEnabled) return;
        uint256 amountIn = 0.01 ether;
        deal(WETH, address(this), amountIn);
        IERC20HooklessAdapterTest(WETH).approve(address(adapter), amountIn);

        vm.expectRevert();
        adapter.swapExactInput(WETH, amountIn, type(uint256).max);
        assertEq(IERC20HooklessAdapterTest(WETH).balanceOf(address(this)), amountIn);
    }
}
