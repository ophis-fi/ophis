// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with OphisRewardsDistributor
abstract contract OphisRewardsDistributorHandler is Properties {

    function handlerAssign(uint256 actorSeed, uint256 ticketSeed, bool tenDollar) public {
        address recipient = actors[actorSeed % actors.length];
        uint256 ticketId = (ticketSeed % distributor.MAX_TICKETS()) + 1;
        uint256 amount = tenDollar ? distributor.TEN_DOLLAR_REWARD() : distributor.ONE_DOLLAR_REWARD();
        bytes32 structHash = keccak256(
            abi.encode(distributor.ASSIGNMENT_TYPEHASH(), recipient, ticketId, amount, distributor.signerEpoch())
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", distributor.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(activeSignerKey, digest);
        try distributor.assign(recipient, ticketId, amount, v, r, s) {
            ghosts.successfulAssignments++;
        } catch {}
    }

    function handlerClaim(uint256 actorSeed) public {
        address recipient = actors[actorSeed % actors.length];
        try distributor.claim(recipient) {
            ghosts.successfulClaims++;
        } catch {}
    }

    function handlerAdmin(uint256 selector) public {
        if (selector % 3 == 0) {
            distributor.setPaused(!distributor.paused());
        } else {
            activeSignerKey = activeSignerKey == REWARD_SIGNER_KEY_A ? REWARD_SIGNER_KEY_B : REWARD_SIGNER_KEY_A;
            distributor.setRewardSigner(vm.addr(activeSignerKey));
        }
    }

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――
}
