// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

import {IAggregatorV3} from "./interfaces/IVaultPolicyDeps.sol";

/// @title Ophis Chainlink floor library
/// @notice Computes the minimum acceptable `buyAmount` for a vault rebalance
/// from two Chainlink token/USD feeds, modeled on the CoW-audited StopLoss
/// pattern (composable-cow `src/types/StopLoss.sol`): validate price > 0,
/// validate freshness, scale both prices to 18 decimals, compare.
///
/// Fail-closed by construction:
///  - an invalid (<= 0) price REVERTS,
///  - a stale price REVERTS,
///  - any overflow in the (checked, 0.8) math REVERTS.
/// A revert means "no order is placed" - the floor can fail closed but never
/// silently compute low.
library OphisChainlinkFloor {
    uint256 internal constant BPS = 10_000;

    error InvalidOraclePrice(address feed);
    error StaleOraclePrice(address feed);
    error UnsupportedFeedDecimals(address feed);

    /// @dev Reads one feed, enforcing validity + freshness, and returns the
    /// price scaled to 18 decimals.
    function read18(
        IAggregatorV3 feed,
        uint8 feedDecimals,
        uint256 maxStaleness
    ) internal view returns (uint256 price18) {
        if (feedDecimals > 18) revert UnsupportedFeedDecimals(address(feed));
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();
        if (answer <= 0) revert InvalidOraclePrice(address(feed));
        // Reject an incomplete round (updatedAt == 0) or an answer carried over
        // from an earlier round (answeredInRound < roundId): a proxy pointing at
        // a stalled or newly-swapped aggregator can return a stale price that the
        // pure updatedAt-age check below would still accept.
        if (updatedAt == 0 || answeredInRound < roundId) {
            revert StaleOraclePrice(address(feed));
        }
        if (block.timestamp > updatedAt + maxStaleness) {
            revert StaleOraclePrice(address(feed));
        }
        price18 = uint256(answer) * (10 ** (18 - feedDecimals));
    }

    /// @dev Oracle floor for selling `sellAmount` of the sell token into the
    /// buy token, minus the configured slippage band:
    ///
    ///   floor = sellAmount * pSell18 * 10^buyDec        (BPS - slippageBps)
    ///           ---------------------------------   *   -----------------
    ///                 pBuy18 * 10^sellDec                      BPS
    ///
    /// The multiplication is done BEFORE the division (single expression) so
    /// small sell amounts into higher-decimal buy tokens do not truncate to
    /// zero. With realistic magnitudes (sellAmount < 1e38, prices < 1e15 USD)
    /// the intermediate product stays far below 2^256; a pathological input
    /// overflows checked math and reverts (fail-closed), never wraps.
    function floorBuyAmount(
        uint256 sellAmount,
        uint256 sellPrice18,
        uint8 sellTokenDecimals,
        uint256 buyPrice18,
        uint8 buyTokenDecimals,
        uint256 slippageBps
    ) internal pure returns (uint256 floor) {
        floor =
            (sellAmount * sellPrice18 * (10 ** buyTokenDecimals)) /
            (buyPrice18 * (10 ** sellTokenDecimals));
        floor = (floor * (BPS - slippageBps)) / BPS;
    }
}
