// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

interface IMetricRouterTest {
    struct ExactInputSingleParams {
        address pool;
        address tokenIn;
        address tokenOut;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        address recipient;
        uint256 deadline;
        uint128 priceLimitX64;
        bytes extensionData;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IMetricQuoterTest {
    function quoteLiveExactInSingle(
        address pool,
        address sender,
        address recipient,
        bool zeroForOne,
        uint128 amountIn,
        uint128 priceLimitX64,
        bytes calldata extensionData
    ) external returns (uint256 amountIn_, uint256 amountOut);
}

interface IMetricTokenTest {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MetricForkTest is Test {
    address constant ROUTER = 0x02201E6f13c41506c7Bb635d7543F98826229aB7;
    address constant QUOTER = 0x3B9ea79f482094323d06064E637a7F4528560fcb;
    address constant FACTORY = 0x2a53833cc95548cf52c7b159110e22D3a9018f32;
    address constant POOL = 0x1E8Fc442AD3606719F7016DED6C17B56C3cA7386;
    address constant SUBMITTER = 0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665;
    address constant SETTLEMENT = 0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function setUp() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC"), vm.envOr("METRIC_FORK_BLOCK", uint256(93311122)));
        assertEq(block.chainid, 4663);
    }

    function testMetricSettlementBothDirections() public {
        _checkPool();
        uint256 received = _swap(WETH, USDG, true, 0.0001 ether);
        _swap(USDG, WETH, false, uint128(received));
    }

    function testMetricRejectsUnattainableOutput() public {
        deal(WETH, SETTLEMENT, 0.0001 ether);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IMetricTokenTest(WETH).approve(ROUTER, 0.0001 ether));
        vm.expectRevert();
        IMetricRouterTest(ROUTER).exactInputSingle(_params(WETH, USDG, true, 0.0001 ether, type(uint128).max));
        vm.stopPrank();
        assertEq(IMetricTokenTest(WETH).balanceOf(SETTLEMENT), 0.0001 ether);
    }

    function testMetricRejectsExpiredSwap() public {
        IMetricRouterTest.ExactInputSingleParams memory params = _params(WETH, USDG, true, 1, 1);
        params.deadline = block.timestamp - 1;
        vm.prank(SETTLEMENT);
        vm.expectRevert();
        IMetricRouterTest(ROUTER).exactInputSingle(params);
    }

    function _checkPool() internal view {
        (bool ok, bytes memory data) = POOL.staticcall(abi.encodeWithSignature("getImmutables()"));
        assertTrue(ok);
        // Independent producer ABI: the first three immutable words bind the pool and token direction.
        (address factory, address token0, address token1) = abi.decode(data, (address, address, address));
        assertEq(factory, FACTORY);
        assertEq(token0, WETH);
        assertEq(token1, USDG);
        (ok, data) = FACTORY.staticcall(abi.encodeWithSignature("isPool(address)", POOL));
        assertTrue(ok && abi.decode(data, (bool)));
    }

    function _swap(address sell, address buy, bool zeroForOne, uint128 amount) internal returns (uint256) {
        // The pool sees the router as sender. The live provider requires a zero-origin read.
        vm.prank(address(0), address(0));
        (uint256 consumed, uint256 quoted) = IMetricQuoterTest(QUOTER)
            .quoteLiveExactInSingle(
                POOL, ROUTER, SETTLEMENT, zeroForOne, amount, zeroForOne ? 0 : type(uint128).max, ""
            );
        assertEq(consumed, amount);
        assertGt(quoted, 0);
        uint128 floor = uint128(quoted * 99 / 100);
        deal(sell, SETTLEMENT, amount);
        uint256 beforeOut = IMetricTokenTest(buy).balanceOf(SETTLEMENT);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IMetricTokenTest(sell).approve(ROUTER, amount));
        uint256 reported = IMetricRouterTest(ROUTER).exactInputSingle(_params(sell, buy, zeroForOne, amount, floor));
        vm.stopPrank();
        uint256 received = IMetricTokenTest(buy).balanceOf(SETTLEMENT) - beforeOut;
        assertEq(received, reported);
        assertGe(received, floor);
        assertEq(IMetricTokenTest(sell).balanceOf(SETTLEMENT), 0);
        return received;
    }

    function _params(address sell, address buy, bool zeroForOne, uint128 amount, uint128 floor)
        internal
        view
        returns (IMetricRouterTest.ExactInputSingleParams memory)
    {
        return IMetricRouterTest.ExactInputSingleParams(
            POOL,
            sell,
            buy,
            zeroForOne,
            amount,
            floor,
            SETTLEMENT,
            block.timestamp + 120,
            zeroForOne ? 0 : type(uint128).max,
            ""
        );
    }
}
