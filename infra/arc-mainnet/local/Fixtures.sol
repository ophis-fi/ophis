// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// Local liquidity fixture, never a production token or router.
contract LocalEURC {
    string public constant name = "Local EURC";
    string public constant symbol = "EURC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract LocalRouter {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    function swap(address sell, uint256 amount, uint256 output, address receiver) external {
        require(sell == USDC || sell == EURC, "unsupported token");
        require(output <= amount, "fixture rate");
        require(IERC20(sell).transferFrom(msg.sender, address(this), amount), "input");
        if (sell == USDC) LocalEURC(EURC).mint(receiver, output);
        else require(IERC20(USDC).transfer(receiver, output), "output");
    }
}

// No Balancer deployment is assumed on Arc. External/internal vault orders fail closed.
contract DisabledVault {
    fallback() external { revert("Arc: ERC20 balances only"); }
}

// ABI-compatible V3 fixture only; prices are deterministic, not AMM math.
contract LocalV3Venue {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    struct QuoteParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }
    struct Router02Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    struct LegacyParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    uint256 public rateBps;
    function setRate(uint256 rate) external { require(rate <= 10000, "fixture rate"); rateBps = rate; }
    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pair(a, b) && fee == 500 ? address(this) : address(0);
    }
    function quoteExactInputSingle(QuoteParams calldata p) external view returns (uint256, uint160, uint32, uint256) {
        require(_pair(p.tokenIn, p.tokenOut) && p.fee == 500 && p.sqrtPriceLimitX96 == 0, "unsupported pool");
        return (p.amountIn * rateBps / 10000, 0, 0, 100000);
    }
    function exactInputSingle(Router02Params calldata p) external returns (uint256) {
        return _swap(p.tokenIn, p.tokenOut, p.fee, p.recipient, p.amountIn, p.amountOutMinimum, p.sqrtPriceLimitX96);
    }
    function exactInputSingle(LegacyParams calldata p) external returns (uint256) {
        require(p.deadline >= block.timestamp, "expired");
        return _swap(p.tokenIn, p.tokenOut, p.fee, p.recipient, p.amountIn, p.amountOutMinimum, p.sqrtPriceLimitX96);
    }
    function _pair(address a, address b) private pure returns (bool) {
        return (a == USDC && b == EURC) || (a == EURC && b == USDC);
    }
    function _swap(address sell, address buy, uint24 fee, address receiver, uint256 amount, uint256 minimum, uint160 limit) private returns (uint256 output) {
        require(_pair(sell, buy) && fee == 500 && limit == 0, "unsupported pool");
        output = amount * rateBps / 10000;
        require(output >= minimum, "slippage");
        require(IERC20(sell).transferFrom(msg.sender, address(this), amount), "input");
        if (buy == EURC) LocalEURC(EURC).mint(receiver, output);
        else require(IERC20(USDC).transfer(receiver, output), "output");
    }
}
