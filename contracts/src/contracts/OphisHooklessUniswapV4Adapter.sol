// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IWETH9, IUniswapV4PoolManager} from "./OphisUniswapV4Adapter.sol";

/// @title OphisHooklessUniswapV4Adapter
/// @notice Immutable Settlement-only adapter for one native ETH/ERC-20
/// Uniswap V4 pool. Ophis orders use WETH, so native wrapping is handled
/// atomically around the swap.
///
/// The pool key is fixed at construction and hooks are always zero. There is
/// no owner, upgrade path, arbitrary-call surface, or configurable recipient.
contract OphisHooklessUniswapV4Adapter {
    error Unauthorized();
    error UnsupportedPair();
    error InvalidConfiguration();
    error InvalidAmount();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error TransferFailed();
    error InvalidCallback();
    error AmountTooLarge();
    error UnexpectedNativeSender();

    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    address public immutable settlement;
    IUniswapV4PoolManager public immutable poolManager;
    IWETH9 public immutable weth;
    address public immutable quoteToken;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    bytes32 private activeCallback;

    constructor(
        address settlement_,
        address poolManager_,
        address weth_,
        address quoteToken_,
        uint24 poolFee_,
        int24 tickSpacing_
    ) {
        if (
            settlement_ == address(0) || poolManager_ == address(0) || weth_ == address(0)
                || quoteToken_ == address(0) || poolFee_ >= 1_000_000 || tickSpacing_ <= 0
                || tickSpacing_ > 32_767
        ) revert InvalidConfiguration();
        settlement = settlement_;
        poolManager = IUniswapV4PoolManager(poolManager_);
        weth = IWETH9(weth_);
        quoteToken = quoteToken_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
    }

    function swapExactInput(address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != settlement) revert Unauthorized();
        if (amountIn == 0) revert InvalidAmount();
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();

        bool zeroForOne;
        if (tokenIn == address(weth)) {
            zeroForOne = true;
        } else if (tokenIn == quoteToken) {
            zeroForOne = false;
        } else {
            revert UnsupportedPair();
        }

        _safeTransferFrom(tokenIn, settlement, address(this), amountIn);
        if (zeroForOne) weth.withdraw(amountIn);

        bytes memory callbackData = abi.encode(zeroForOne, amountIn);
        if (activeCallback != bytes32(0)) revert InvalidCallback();
        activeCallback = keccak256(callbackData);
        amountOut = abi.decode(poolManager.unlock(callbackData), (uint256));
        activeCallback = bytes32(0);

        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        if (zeroForOne) {
            _safeTransfer(quoteToken, settlement, amountOut);
        } else {
            weth.deposit{value: amountOut}();
            if (!weth.transfer(settlement, amountOut)) revert TransferFailed();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || activeCallback != keccak256(data)) {
            revert InvalidCallback();
        }

        (bool zeroForOne, uint256 amountIn) = abi.decode(data, (bool, uint256));
        IUniswapV4PoolManager.PoolKey memory key = IUniswapV4PoolManager.PoolKey({
            currency0: address(0),
            currency1: quoteToken,
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: address(0)
        });
        IUniswapV4PoolManager.SwapParams memory params = IUniswapV4PoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne
                ? MIN_SQRT_PRICE_PLUS_ONE
                : MAX_SQRT_PRICE_MINUS_ONE
        });

        int256 delta = poolManager.swap(key, params, "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        int128 outputDelta = zeroForOne ? amount1 : amount0;
        if (outputDelta <= 0) revert InvalidAmount();
        uint256 amountOut = uint128(outputDelta);

        if (zeroForOne) {
            poolManager.settle{value: amountIn}();
            poolManager.take(quoteToken, address(this), amountOut);
        } else {
            poolManager.sync(quoteToken);
            _safeTransfer(quoteToken, address(poolManager), amountIn);
            poolManager.settle();
            poolManager.take(address(0), address(this), amountOut);
        }
        return abi.encode(amountOut);
    }

    receive() external payable {
        if (msg.sender != address(poolManager) && msg.sender != address(weth)) {
            revert UnexpectedNativeSender();
        }
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        (bool success, bytes memory result) =
            token.call(abi.encodeWithSignature("transfer(address,uint256)", recipient, amount));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address owner, address recipient, uint256 amount)
        private
    {
        (bool success, bytes memory result) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", owner, recipient, amount)
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
