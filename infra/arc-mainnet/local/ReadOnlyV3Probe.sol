// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IProbeToken {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// Test helper installed by eth_call state override only. Never deploy or fund it.
/// Buy EURC then sell the received EURC back, so no EURC storage override is needed.
contract ReadOnlyV3Probe {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;

    fallback(bytes calldata data) external returns (bytes memory) {
        (address router, uint24 fee, bool legacy, uint256 amount, uint256 minimum) =
            abi.decode(data, (address, uint24, bool, uint256, uint256));
        require(block.chainid == 5042 && amount > 0 && minimum > 0, "probe parameters");
        require(
            (router == 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77 && !legacy) ||
            (router == 0xa50eDe66a573eE5bB37E28AF5789B76aE5FEb828 && !legacy) ||
            (router == 0xEA0129203FBB99ebEea3f78B2d05b924f17FB556 && legacy), "probe router"
        );
        uint256 received = swap(router, fee, legacy, USDC, EURC, amount, minimum);
        uint256 returned = swap(router, fee, legacy, EURC, USDC, received, 1);
        return abi.encode(received, returned);
    }

    function swap(address router, uint24 fee, bool legacy, address sell, address buy, uint256 amount, uint256 minimum)
        private returns (uint256 received)
    {
        uint256 beforeSell = IProbeToken(sell).balanceOf(address(this));
        uint256 beforeBuy = IProbeToken(buy).balanceOf(address(this));
        require(IProbeToken(sell).approve(router, amount), "probe approval");
        bytes memory data = legacy
            ? abi.encodeWithSelector(bytes4(0x414bf389), sell, buy, fee, address(this), type(uint256).max, amount, minimum, uint160(0))
            : abi.encodeWithSelector(bytes4(0x04e45aaf), sell, buy, fee, address(this), amount, minimum, uint160(0));
        (bool ok, bytes memory result) = router.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        received = IProbeToken(buy).balanceOf(address(this)) - beforeBuy;
        require(beforeSell - IProbeToken(sell).balanceOf(address(this)) == amount, "probe input");
        require(received >= minimum && abi.decode(result, (uint256)) == received, "probe output");
    }
}

interface IProbeSettlement {
    function vaultRelayer() external view returns (address);
    function setPreSignature(bytes calldata uid, bool signed) external;
    function filledAmount(bytes calldata uid) external view returns (uint256);
}

/// Test-only runtime override at the authorized solver EOA. It acts as both a
/// disposable trader and solver; the actual settlement/router code is unchanged.
contract ReadOnlySettlementProbe {
    fallback(bytes calldata data) external returns (bytes memory) {
        (address settlement, address sell, address buy, uint256 amount, uint256 minimum, bytes memory uid, bytes memory settleData) =
            abi.decode(data, (address, address, address, uint256, uint256, bytes, bytes));
        require(block.chainid == 5042 && sell != buy && amount > 0 && minimum > 0, "probe parameters");
        uint256[4] memory beforeBalances = [IProbeToken(sell).balanceOf(address(this)), IProbeToken(buy).balanceOf(address(this)),
            IProbeToken(sell).balanceOf(settlement), IProbeToken(buy).balanceOf(settlement)];
        IProbeSettlement target = IProbeSettlement(settlement);
        require(IProbeToken(sell).approve(target.vaultRelayer(), amount), "probe approval");
        target.setPreSignature(uid, true);
        (bool ok, bytes memory result) = settlement.call(settleData);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        uint256 received = IProbeToken(buy).balanceOf(address(this)) - beforeBalances[1];
        require(beforeBalances[0] - IProbeToken(sell).balanceOf(address(this)) == amount, "probe input");
        require(received >= minimum && target.filledAmount(uid) == amount, "probe output/fill");
        require(IProbeToken(sell).balanceOf(settlement) >= beforeBalances[2] &&
            IProbeToken(buy).balanceOf(settlement) >= beforeBalances[3], "probe depleted settlement buffer");
        return abi.encode(received);
    }
}
