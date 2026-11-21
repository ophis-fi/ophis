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
    struct ExactInputParams {
        address[] tokens;
        address[] pools;
        bytes[] extensionDatas;
        uint256 zeroForOneBitMap;
        uint128 amountIn;
        uint128 amountOutMinimum;
        address recipient;
        uint256 deadline;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256);
    // Same field layout as ExactInputParams: (tokens, pools, extensionDatas, bitmap, amountOut, amountInMaximum,
    // recipient, deadline).
    function exactOutput(ExactInputParams calldata params) external payable returns (uint256);
}

interface IMetricQuoterTest {
    function quoteLiveExactOutSingle(
        address pool,
        address sender,
        address recipient,
        bool zeroForOne,
        uint128 amountOutDesired,
        uint128 priceLimitX64,
        bytes calldata extensionData
    ) external returns (uint256 amountIn, uint256 amountOut);
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

    /// NVDA -> USDG -> META through two pinned pools. The solver quotes each hop separately at one block (the
    /// router as first recipient, Settlement as last); execution must pay exactly the second quote.
    function testMetricTwoPoolRoute() public {
        address nvda = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
        address meta = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
        address[] memory pools = new address[](2);
        pools[0] = 0xBc6426CdBCE142dfbff33303dc0923509f61eedc;
        pools[1] = 0x90CABdA18279BBB3D935989aF807b08B0e8CeC61;
        uint128 amount = 0.001 ether;
        vm.prank(address(0), address(0));
        (uint256 consumed, uint256 mid) =
            IMetricQuoterTest(QUOTER).quoteLiveExactInSingle(pools[0], ROUTER, ROUTER, true, amount, 0, "");
        assertEq(consumed, amount);
        vm.prank(address(0), address(0));
        (uint256 midConsumed, uint256 quoted) = IMetricQuoterTest(QUOTER)
            .quoteLiveExactInSingle(pools[1], ROUTER, SETTLEMENT, false, uint128(mid), type(uint128).max, "");
        assertEq(midConsumed, mid);
        assertGt(quoted, 0);

        address[] memory tokens = new address[](3);
        (tokens[0], tokens[1], tokens[2]) = (nvda, USDG, meta);
        // Bit i is the direction of pools[i]: NVDA is token0 of the first pool, USDG token1 of the second.
        IMetricRouterTest.ExactInputParams memory params = IMetricRouterTest.ExactInputParams(
            tokens, pools, new bytes[](2), 1, amount, uint128(quoted), SETTLEMENT, block.timestamp + 300
        );
        deal(nvda, SETTLEMENT, amount);
        uint256 beforeOut = IMetricTokenTest(meta).balanceOf(SETTLEMENT);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IMetricTokenTest(nvda).approve(ROUTER, amount));
        // One wei above the quote is unattainable, while balance and allowance are still in place.
        params.amountOutMinimum = uint128(quoted) + 1;
        vm.expectRevert();
        IMetricRouterTest(ROUTER).exactInput(params);
        params.amountOutMinimum = uint128(quoted);
        uint256 reported = IMetricRouterTest(ROUTER).exactInput(params);
        vm.stopPrank();
        assertEq(reported, quoted);
        assertEq(IMetricTokenTest(meta).balanceOf(SETTLEMENT) - beforeOut, quoted);
        assertEq(IMetricTokenTest(nvda).balanceOf(SETTLEMENT), 0);
        assertEq(IMetricTokenTest(USDG).balanceOf(ROUTER), 0);
    }

    /// Buy an exact 0.0001 META with NVDA through two pinned pools. The solver quotes the last hop first
    /// (Settlement as recipient), then the first hop for that input with the last pool as recipient; execution
    /// must take exactly the quoted input and pay exactly the requested output.
    function testMetricTwoPoolExactOutput() public {
        address nvda = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
        address meta = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
        address[] memory pools = new address[](2);
        pools[0] = 0xBc6426CdBCE142dfbff33303dc0923509f61eedc;
        pools[1] = 0x90CABdA18279BBB3D935989aF807b08B0e8CeC61;
        uint128 wanted = 0.0001 ether;
        vm.prank(address(0), address(0));
        (uint256 mid, uint256 lastOut) = IMetricQuoterTest(QUOTER)
            .quoteLiveExactOutSingle(pools[1], ROUTER, SETTLEMENT, false, wanted, type(uint128).max, "");
        assertEq(lastOut, wanted);
        vm.prank(address(0), address(0));
        (uint256 cost, uint256 midOut) =
            IMetricQuoterTest(QUOTER).quoteLiveExactOutSingle(pools[0], ROUTER, pools[1], true, uint128(mid), 0, "");
        assertEq(midOut, mid);
        assertGt(cost, 0);

        address[] memory tokens = new address[](3);
        (tokens[0], tokens[1], tokens[2]) = (nvda, USDG, meta);
        IMetricRouterTest.ExactInputParams memory params = IMetricRouterTest.ExactInputParams(
            tokens, pools, new bytes[](2), 1, wanted, uint128(cost) - 1, SETTLEMENT, block.timestamp + 300
        );
        // Funded and approved above the cost, so only the cap can stop the swap.
        deal(nvda, SETTLEMENT, cost * 2);
        uint256 beforeOut = IMetricTokenTest(meta).balanceOf(SETTLEMENT);
        vm.startPrank(SETTLEMENT, SUBMITTER);
        assertTrue(IMetricTokenTest(nvda).approve(ROUTER, cost * 2));
        // One wei under the quoted cost is not enough.
        vm.expectRevert();
        IMetricRouterTest(ROUTER).exactOutput(params);
        params.amountOutMinimum = uint128(cost);
        uint256 spent = IMetricRouterTest(ROUTER).exactOutput(params);
        vm.stopPrank();
        assertEq(spent, cost);
        assertEq(IMetricTokenTest(meta).balanceOf(SETTLEMENT) - beforeOut, wanted);
        assertEq(IMetricTokenTest(nvda).balanceOf(SETTLEMENT), cost);
        assertEq(IMetricTokenTest(USDG).balanceOf(ROUTER), 0);
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
