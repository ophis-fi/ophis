// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Minimal interface for Robinhood's canonical wrapped native token.
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/// @notice Minimal interface for the Uniswap V4 singleton.
interface IUniswapV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// @title OphisUniswapV4Adapter
/// @notice Settlement-only adapter for Robinhood's canonical native ETH/USDG
/// Uniswap V4 pool. Ophis orders trade WETH, so this adapter performs the
/// WETH/native conversion atomically around the V4 swap.
///
/// The contract is deliberately immutable and pair-specific. It cannot route
/// arbitrary tokens, call arbitrary hooks, change its pool, or transfer output
/// anywhere except the Ophis Settlement contract.
contract OphisUniswapV4Adapter {
    error Unauthorized();
    error UnsupportedPair();
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
    address public immutable usdg;

    bytes32 private activeCallback;

    constructor(address settlement_, address poolManager_, address weth_, address usdg_) {
        if (
            settlement_ == address(0) || poolManager_ == address(0) || weth_ == address(0)
                || usdg_ == address(0)
        ) revert InvalidAmount();
        settlement = settlement_;
        poolManager = IUniswapV4PoolManager(poolManager_);
        weth = IWETH9(weth_);
        usdg = usdg_;
    }

    /// @notice Swap an exact WETH or USDG amount through the canonical pool.
    /// Output is always returned to Ophis Settlement.
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
        } else if (tokenIn == usdg) {
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
            _safeTransfer(usdg, settlement, amountOut);
        } else {
            weth.deposit{value: amountOut}();
            if (!weth.transfer(settlement, amountOut)) revert TransferFailed();
        }
    }

    /// @notice Uniswap V4 unlock callback. Only the immutable PoolManager can
    /// enter it and only for the exact payload committed by swapExactInput.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || activeCallback != keccak256(data)) {
            revert InvalidCallback();
        }

        (bool zeroForOne, uint256 amountIn) = abi.decode(data, (bool, uint256));
        IUniswapV4PoolManager.PoolKey memory key = IUniswapV4PoolManager.PoolKey({
            currency0: address(0),
            currency1: usdg,
            fee: 500,
            tickSpacing: 10,
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
            poolManager.take(usdg, address(this), amountOut);
        } else {
            poolManager.sync(usdg);
            _safeTransfer(usdg, address(poolManager), amountIn);
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
