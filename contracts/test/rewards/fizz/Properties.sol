// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Snapshots} from "./Snapshots.sol";
import {PropertiesAsserts} from "./utils/PropertiesAsserts.sol";

/// @notice Contains the functions that check the properties (invariants)
abstract contract Properties is PropertiesAsserts, Snapshots {

    function property_inventoryCaps() public view returns (bool) {
        return distributor.totalAssigned() <= distributor.MAX_TICKETS()
            && distributor.oneDollarAssigned() <= distributor.MAX_ONE_DOLLAR_REWARDS()
            && distributor.tenDollarAssigned() <= distributor.MAX_TEN_DOLLAR_REWARDS()
            && distributor.totalAssignedValue() <= distributor.MAX_LIFETIME_PAYOUT();
    }

    function property_counterConservation() public view returns (bool) {
        return distributor.totalAssigned() == distributor.oneDollarAssigned() + distributor.tenDollarAssigned()
            && distributor.totalClaimed() <= distributor.totalAssigned()
            && distributor.totalClaimedValue() <= distributor.totalAssignedValue();
    }

    function property_tokenConservation() public view returns (bool) {
        return rewardToken.balanceOf(address(distributor)) + distributor.totalClaimedValue()
            == distributor.MAX_LIFETIME_PAYOUT();
    }

    function property_ghostCountersMatch() public view returns (bool) {
        return ghosts.successfulAssignments == distributor.totalAssigned()
            && ghosts.successfulClaims == distributor.totalClaimed();
    }

    // ―――――――――――――――――――― Global properties ―――――――――――――――――――――
    // These properties must always hold after any function call.
    // They MUST BE PUBLIC so that fuzzers can find and call them.

    // ――――――――――――――――――― Specific properties ――――――――――――――――――――
    // These properties must hold after specific function calls.
    // They MUST BE INTERNAL and called at the end of the relevant handlers.
}
