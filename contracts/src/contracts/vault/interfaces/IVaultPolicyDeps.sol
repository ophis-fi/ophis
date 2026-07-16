// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

/// @dev Minimal Safe surface the policy module needs. Matches the canonical
/// Safe v1.3.0+ ABI (enums encode as uint8, so the selectors are identical).
/// Deliberately minimal: the module never delegatecalls and never touches
/// owner management.
interface ISafe {
    /// @dev Executes a transaction from an enabled module and returns the
    /// call's return data (needed to validate optional-bool ERC20 approves).
    /// `operation` MUST always be 0 (CALL) in this codebase.
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation
    ) external returns (bool success, bytes memory returnData);

    function getOwners() external view returns (address[] memory);
}

/// @dev Minimal settlement surface (Ophis non-canonical on self-hosted
/// chains, canonical CoW elsewhere - byte-identical ABI either way).
interface IGPv2Settlement {
    function domainSeparator() external view returns (bytes32);

    function vaultRelayer() external view returns (address);

    function setPreSignature(bytes calldata orderUid, bool signed) external;

    function preSignature(
        bytes calldata orderUid
    ) external view returns (uint256);
}

/// @dev Chainlink AggregatorV3 surface used by the floor check.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @dev ERC20 metadata read once at module deploy (decimals are immutable in
/// practice; caching them removes a per-call external read AND a config knob
/// that could be mis-set).
interface IERC20Metadata {
    function decimals() external view returns (uint8);
}
