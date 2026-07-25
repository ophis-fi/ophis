// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {IERC20} from "src/contracts/interfaces/IERC20.sol";

/// @dev Minimal standard ERC20 (true-returning) with an open mint.
contract MockERC20 is IERC20 {
    string public constant name = "MockERC20";
    string public constant symbol = "MOCK";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MockERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        require(allowance[from][msg.sender] >= amount, "MockERC20: allowance");
        require(balanceOf[from] >= amount, "MockERC20: balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) public virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// @dev USDT-style token: transfer/approve/transferFrom return NOTHING.
/// Exercises the sweep path for tokens whose calls succeed with empty
/// returndata (GPv2Interaction.execute never inspects returndata).
contract NoReturnERC20 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "NoReturnERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "NoReturnERC20: allowance");
        require(balanceOf[from] >= amount, "NoReturnERC20: balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }
}

/// @dev Broken token: transfer() returns false WITHOUT moving funds. The
/// interaction "succeeds" (call-level) but the liquidator's post-settlement
/// balance-delta check must catch the silent no-op.
contract FalseReturnERC20 is MockERC20 {
    constructor() MockERC20(18) {}

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev Broken token: approve(spender, 0) is silently ignored (allowance
/// stays), so the same-settle revoke no-ops and the liquidator's
/// zero-allowance post-check must fire.
contract StickyApproveERC20 is MockERC20 {
    constructor() MockERC20(18) {}

    function approve(address spender, uint256 amount) public override returns (bool) {
        if (amount == 0) {
            return true; // ignore the revoke
        }
        return super.approve(spender, amount);
    }
}

/// @dev Configurable venue router. `swap` pulls `amountIn` of `tokenIn` from
/// msg.sender (the Settlement contract, via the exact approval) and pays
/// `amountIn * rateBps / 10_000` of `tokenOut` from its own inventory to
/// `recipient` (or to `misdirectTo` when set, models a venue that ignores
/// the requested recipient).
contract MockVenueRouter {
    uint256 public rateBps = 10_000;
    address public misdirectTo;
    bool public skipPull;

    function setRateBps(uint256 bps) external {
        rateBps = bps;
    }

    function setMisdirectTo(address to) external {
        misdirectTo = to;
    }

    function setSkipPull(bool v) external {
        skipPull = v;
    }

    function swap(MockERC20 tokenIn, uint256 amountIn, MockERC20 tokenOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        if (!skipPull) {
            tokenIn.transferFrom(msg.sender, address(this), amountIn);
        }
        amountOut = (amountIn * rateBps) / 10_000;
        address to = misdirectTo == address(0) ? recipient : misdirectTo;
        require(tokenOut.transfer(to, amountOut), "MockVenueRouter: payout");
    }
}
