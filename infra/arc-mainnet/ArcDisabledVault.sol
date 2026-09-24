// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8.30;

/// @dev Arc supports external ERC20 balances only. No Balancer vault is assumed.
/// Any internal-balance or Balancer swap attempt fails atomically.
contract ArcDisabledVault {
    fallback() external { revert("Arc: Balancer vault disabled"); }
}
