// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {OphisRewardsDistributor} from "../src/contracts/rewards/OphisRewardsDistributor.sol";

contract DeployRewardsDistributor is Script {
    uint256 private constant ROBINHOOD_CHAIN_ID = 4663;
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address private constant REWARDS_SAFE = 0xB13Ab19F5FeC601813a46D877398B5Eb89eF10Da;
    address private constant REWARD_SIGNER = 0x9a9DC48DA629a1370d8c50821F65da3587739042;

    function run() external returns (OphisRewardsDistributor distributor) {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "wrong chain");
        require(USDG.code.length > 0, "USDG missing");
        require(REWARDS_SAFE.code.length > 0, "Safe missing");
        require(REWARD_SIGNER.code.length == 0, "signer must be EOA");

        vm.startBroadcast();
        distributor = new OphisRewardsDistributor(USDG, REWARDS_SAFE, REWARD_SIGNER);
        vm.stopBroadcast();

        require(address(distributor.rewardToken()) == USDG, "token mismatch");
        require(distributor.owner() == REWARDS_SAFE, "owner mismatch");
        require(distributor.rewardSigner() == REWARD_SIGNER, "signer mismatch");
        require(distributor.DOMAIN_SEPARATOR() != bytes32(0), "domain missing");
    }
}
