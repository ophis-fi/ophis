// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {OphisUniswapV4Adapter, IUniswapV4PoolManager} from "../src/contracts/OphisUniswapV4Adapter.sol";
import {OphisHooklessUniswapV4Adapter} from "../src/contracts/OphisHooklessUniswapV4Adapter.sol";
import {OphisFablesAdapter} from "../src/contracts/OphisFablesAdapter.sol";
import {MockERC20} from "./OphisFeeLiquidator/Mocks.sol";

interface INativeSwapAdapter {
    function swapExactInput(address tokenIn, uint256 amountIn, uint256 minimum) external returns (uint256);
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

contract NativeSettlementWeth is MockERC20 {
    constructor() MockERC20(18) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "withdraw failed");
    }
}

contract NativeSettlementPoolManager is IUniswapV4PoolManager {
    address public syncedCurrency;
    uint256 public paid;

    function sync(address currency) external {
        syncedCurrency = currency;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return INativeSwapAdapter(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory, SwapParams memory params, bytes calldata) external pure returns (int256) {
        require(params.zeroForOne && params.amountSpecified == -1 ether, "unexpected swap");
        return (-int256(1 ether) << 128) | int256(1e6);
    }

    function settle() external payable returns (uint256) {
        // Match PoolManager's native settlement precondition.
        require(syncedCurrency == address(0), "native currency must be synced");
        paid += msg.value;
        return msg.value;
    }

    function take(address currency, address to, uint256 amount) external {
        require(MockERC20(currency).transfer(to, amount), "take failed");
    }
}

contract NativeAdapterSettlementTest is Test {
    function testNativeInputResetsSettlementCurrencyForEveryAdapter() public {
        NativeSettlementWeth weth = new NativeSettlementWeth();
        MockERC20 quote = new MockERC20(6);
        NativeSettlementPoolManager manager = new NativeSettlementPoolManager();
        address[3] memory adapters = [
            address(new OphisUniswapV4Adapter(address(this), address(manager), address(weth), address(quote))),
            address(new OphisHooklessUniswapV4Adapter(address(this), address(manager), address(weth), address(quote), 500, 10)),
            address(new OphisFablesAdapter(address(this), address(manager), address(weth), address(quote)))
        ];
        vm.deal(address(this), 3 ether);
        weth.deposit{value: 3 ether}();
        quote.mint(address(manager), 3e6);

        for (uint256 i; i < adapters.length; ++i) {
            manager.sync(address(quote));
            weth.approve(adapters[i], 1 ether);
            uint256 output = INativeSwapAdapter(adapters[i]).swapExactInput(address(weth), 1 ether, 1e6);
            assertEq(output, 1e6);
            assertEq(manager.syncedCurrency(), address(0));
            assertEq(manager.paid(), (i + 1) * 1 ether);
            assertEq(quote.balanceOf(address(this)), (i + 1) * 1e6);
            assertEq(weth.balanceOf(adapters[i]), 0);
            assertEq(adapters[i].balance, 0);
        }
    }
}
