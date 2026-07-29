// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {
    OphisUniswapV4Adapter
} from "../../src/contracts/OphisUniswapV4Adapter.sol";

interface IERC20AdapterTest {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

contract OphisUniswapV4AdapterForkTest is Test {
    address private constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    OphisUniswapV4Adapter private adapter;
    bool private forkEnabled;

    function setUp() external {
        string memory rpcUrl = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        forkEnabled = true;
        vm.createSelectFork(rpcUrl);
        adapter = new OphisUniswapV4Adapter(address(this), POOL_MANAGER, WETH, USDG);
    }

    function testSwapWethToUsdg() external {
        if (!forkEnabled) return;
        uint256 amountIn = 0.01 ether;
        deal(WETH, address(this), amountIn);
        IERC20AdapterTest(WETH).approve(address(adapter), amountIn);

        uint256 beforeBalance = IERC20AdapterTest(USDG).balanceOf(address(this));
        uint256 amountOut = adapter.swapExactInput(WETH, amountIn, 1);

        assertGt(amountOut, 1);
        assertEq(IERC20AdapterTest(USDG).balanceOf(address(this)) - beforeBalance, amountOut);
        assertEq(address(adapter).balance, 0);
        assertEq(IERC20AdapterTest(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20AdapterTest(USDG).balanceOf(address(adapter)), 0);
    }

    function testSwapUsdgToWeth() external {
        if (!forkEnabled) return;
        uint256 amountIn = 10e6;
        deal(USDG, address(this), amountIn);
        IERC20AdapterTest(USDG).approve(address(adapter), amountIn);

        uint256 beforeBalance = IERC20AdapterTest(WETH).balanceOf(address(this));
        uint256 amountOut = adapter.swapExactInput(USDG, amountIn, 1);

        assertGt(amountOut, 1);
        assertEq(IERC20AdapterTest(WETH).balanceOf(address(this)) - beforeBalance, amountOut);
        assertEq(address(adapter).balance, 0);
        assertEq(IERC20AdapterTest(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20AdapterTest(USDG).balanceOf(address(adapter)), 0);
    }

    function testOnlySettlementCanSwap() external {
        if (!forkEnabled) return;
        vm.prank(address(0xBAD));
        vm.expectRevert(OphisUniswapV4Adapter.Unauthorized.selector);
        adapter.swapExactInput(WETH, 1, 1);
    }

    function testMinimumOutputRevertsAtomically() external {
        if (!forkEnabled) return;
        uint256 amountIn = 0.01 ether;
        deal(WETH, address(this), amountIn);
        IERC20AdapterTest(WETH).approve(address(adapter), amountIn);

        vm.expectRevert();
        adapter.swapExactInput(WETH, amountIn, type(uint256).max);
        assertEq(IERC20AdapterTest(WETH).balanceOf(address(this)), amountIn);
    }
}
