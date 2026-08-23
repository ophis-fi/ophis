// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface IERC20OtcFork {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IWethOtcFork is IERC20OtcFork {
    function deposit() external payable;
}

interface ISwapboardV1Fork {
    struct Order {
        address maker;
        bool active;
        address tokenA;
        uint256 amountA;
        address tokenB;
        uint256 amountB;
    }

    error DeadlineExpired();
    error OrderNotActive(uint256 orderId);

    function weth() external view returns (address);
    function nextOrderId() external view returns (uint256);
    function createOrder(address tokenA, uint256 amountA, address tokenB, uint256 amountB)
        external
        returns (uint256 orderId);
    function fillOrder(uint256 orderId, uint256 deadline) external;
    function cancelOrder(uint256 orderId) external;
    function getOrder(uint256 orderId) external view returns (Order memory);
}

/// @title Milestone C preflight against the immutable Ethereum Swapboard v1.
/// @notice Exercises only createOrder/fillOrder/cancelOrder against latest
/// mainnet state. Runtime bytecode and WETH are pinned; using latest avoids an
/// archive-RPC launch dependency. Native-ETH selectors are deliberately absent.
///
/// Run:
/// forge test --fork-url "$OPHIS_FORK_RPC_ETH" \
///   --match-path test/otc-fork/OtcSwapboardEthereumFork.t.sol
contract OtcSwapboardEthereumForkTest is Test {
    address internal constant BOARD = 0x000000fF3D7A2d373615141d7489Ca66683DbecF;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    bytes32 internal constant RUNTIME_CODE_HASH = 0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1;
    address internal constant MAKER = address(0xA11CE);
    address internal constant TAKER = address(0xB0B);
    address internal constant RACER = address(0xCAFE);
    address internal constant USDC_WHALE = 0x28C6c06298d514Db089934071355E5743bf21d60;

    ISwapboardV1Fork internal board;

    function setUp() public {
        board = ISwapboardV1Fork(BOARD);
    }

    function _createWethForUsdc(uint256 amountA, uint256 amountB) internal returns (uint256 orderId) {
        vm.deal(MAKER, amountA);
        vm.startPrank(MAKER);
        IWethOtcFork(WETH).deposit{value: amountA}();
        IERC20OtcFork(WETH).approve(BOARD, amountA);
        orderId = board.createOrder(WETH, amountA, USDC, amountB);
        vm.stopPrank();
    }

    function _fundUsdc(address recipient, uint256 amount) internal {
        vm.prank(USDC_WHALE);
        assertTrue(IERC20OtcFork(USDC).transfer(recipient, amount));
    }

    function test_pinned_identity_and_reviewed_tokens() public view {
        assertEq(BOARD.codehash, RUNTIME_CODE_HASH);
        assertEq(board.weth(), WETH);
        assertGt(WETH.code.length, 0);
        assertGt(USDC.code.length, 0);
        assertGt(DAI.code.length, 0);
    }

    function test_create_and_fill_with_exact_approvals_and_nonzero_deadline() public {
        uint256 amountA = 2 ether;
        uint256 amountB = 8_000e6;
        uint256 makerUsdcBefore = IERC20OtcFork(USDC).balanceOf(MAKER);
        uint256 boardWethBefore = IERC20OtcFork(WETH).balanceOf(BOARD);
        uint256 orderId = _createWethForUsdc(amountA, amountB);

        assertEq(IERC20OtcFork(WETH).allowance(MAKER, BOARD), 0);
        assertEq(IERC20OtcFork(WETH).balanceOf(BOARD), boardWethBefore + amountA);

        _fundUsdc(TAKER, amountB);
        vm.startPrank(TAKER);
        IERC20OtcFork(USDC).approve(BOARD, amountB);
        uint256 deadline = block.timestamp + 180;
        assertGt(deadline, block.timestamp);
        board.fillOrder(orderId, deadline);
        vm.stopPrank();

        assertEq(IERC20OtcFork(USDC).allowance(TAKER, BOARD), 0);
        assertEq(IERC20OtcFork(WETH).balanceOf(TAKER), amountA);
        assertEq(IERC20OtcFork(USDC).balanceOf(MAKER), makerUsdcBefore + amountB);
        assertEq(IERC20OtcFork(WETH).balanceOf(BOARD), boardWethBefore);
        assertFalse(board.getOrder(orderId).active);
    }

    function test_create_and_cancel_returns_the_exact_escrow() public {
        uint256 amountA = 1 ether;
        uint256 boardWethBefore = IERC20OtcFork(WETH).balanceOf(BOARD);
        uint256 orderId = _createWethForUsdc(amountA, 4_000e6);

        vm.prank(MAKER);
        board.cancelOrder(orderId);

        assertEq(IERC20OtcFork(WETH).balanceOf(MAKER), amountA);
        assertEq(IERC20OtcFork(WETH).balanceOf(BOARD), boardWethBefore);
        assertFalse(board.getOrder(orderId).active);
    }

    function test_expired_deadline_reverts_and_preserves_active_escrow() public {
        uint256 amountB = 4_000e6;
        uint256 boardWethBefore = IERC20OtcFork(WETH).balanceOf(BOARD);
        uint256 orderId = _createWethForUsdc(1 ether, amountB);
        _fundUsdc(TAKER, amountB);
        vm.prank(TAKER);
        IERC20OtcFork(USDC).approve(BOARD, amountB);

        uint256 expired = block.timestamp + 1;
        vm.warp(expired + 1);
        vm.prank(TAKER);
        vm.expectRevert(ISwapboardV1Fork.DeadlineExpired.selector);
        board.fillOrder(orderId, expired);

        assertTrue(board.getOrder(orderId).active);
        assertEq(IERC20OtcFork(WETH).balanceOf(BOARD), boardWethBefore + 1 ether);
    }

    function test_only_one_competing_fill_can_settle() public {
        uint256 amountB = 4_000e6;
        uint256 orderId = _createWethForUsdc(1 ether, amountB);
        _fundUsdc(TAKER, amountB);
        _fundUsdc(RACER, amountB);
        vm.prank(TAKER);
        IERC20OtcFork(USDC).approve(BOARD, amountB);
        vm.prank(RACER);
        IERC20OtcFork(USDC).approve(BOARD, amountB);

        vm.prank(TAKER);
        board.fillOrder(orderId, block.timestamp + 180);
        vm.prank(RACER);
        vm.expectRevert(abi.encodeWithSelector(ISwapboardV1Fork.OrderNotActive.selector, orderId));
        board.fillOrder(orderId, block.timestamp + 180);

        assertEq(IERC20OtcFork(WETH).balanceOf(TAKER), 1 ether);
        assertEq(IERC20OtcFork(WETH).balanceOf(RACER), 0);
    }

    function test_fill_wins_over_late_cancel() public {
        uint256 amountB = 4_000e6;
        uint256 orderId = _createWethForUsdc(1 ether, amountB);
        _fundUsdc(TAKER, amountB);
        vm.prank(TAKER);
        IERC20OtcFork(USDC).approve(BOARD, amountB);
        vm.prank(TAKER);
        board.fillOrder(orderId, block.timestamp + 180);

        vm.prank(MAKER);
        vm.expectRevert(abi.encodeWithSelector(ISwapboardV1Fork.OrderNotActive.selector, orderId));
        board.cancelOrder(orderId);
    }

    function test_missing_approval_reverts_without_creating_an_order() public {
        vm.deal(MAKER, 1 ether);
        vm.prank(MAKER);
        IWethOtcFork(WETH).deposit{value: 1 ether}();
        uint256 nextBefore = board.nextOrderId();
        vm.prank(MAKER);
        vm.expectRevert();
        board.createOrder(WETH, 1 ether, USDC, 4_000e6);
        assertEq(board.nextOrderId(), nextBefore);
    }
}
