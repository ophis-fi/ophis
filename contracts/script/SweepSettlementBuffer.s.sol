// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console} from "forge-std/Script.sol";

import {GPv2Settlement} from "../src/contracts/GPv2Settlement.sol";
import {GPv2Interaction} from "../src/contracts/libraries/GPv2Interaction.sol";
import {GPv2Trade} from "../src/contracts/libraries/GPv2Trade.sol";
import {IERC20} from "../src/contracts/interfaces/IERC20.sol";

/// @title Sweep Settlement Buffer to Recipient Safe
///
/// Calls `Settlement.settle()` with empty trades and a single batch of post-
/// interactions that transfer the Settlement contract's accumulated ERC20
/// balance (CIP-75 partner-fee buffer) to a designated recipient.
///
/// On our Ophis OP fork at `0x310784c7…`, the CIP-75 partner-fee mechanism
/// reduces the user's executed buy amount by the calculated fee, but does
/// NOT atomically transfer to `partnerFee.recipient`. The fee accumulates
/// in Settlement. Without this sweep, the buffer is recycled into future-
/// trader price improvement (CoW's default behavior), which is functionally
/// equivalent to ZERO Ophis revenue.
///
/// This is option B1 from `docs/audits/2026-05-20-cip75-partner-fee-bypass.md`.
/// Per the CoW Settlement design, settle() accepts empty trades and any
/// solver-allowlisted caller can submit arbitrary post-interactions. Our
/// driver-submitter EOA `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1` is
/// allowlisted (added via Safe vote 2026-05-20).
///
/// Inputs (env vars):
///   SETTLEMENT          Settlement contract address (default: Ophis OP)
///   SAFE                Recipient Safe (default: 0x858f0F5e…CeF8)
///   TOKENS              Comma-separated ERC20 addresses to sweep
///   MIN_TOTAL_WEI       Skip if sum-of-balances-as-wei is below this
///                       (default: 1e15 = 0.001 ETH equivalent, per CoW's
///                       partner-fee payout threshold)
///
/// Usage:
///   # Dry-run (simulates the tx, prints calldata, does NOT broadcast):
///   forge script SweepSettlementBuffer --rpc-url $RPC --sender $EOA
///
///   # Live broadcast:
///   PRIVATE_KEY=... forge script SweepSettlementBuffer \
///     --rpc-url $RPC --broadcast
contract SweepSettlementBuffer is Script {
    // Ophis OP defaults
    address constant DEFAULT_SETTLEMENT = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    address constant DEFAULT_SAFE = 0x858f0F5eE954846D47155F5203c04aF1819eCeF8;
    uint256 constant DEFAULT_MIN_TOTAL_WEI = 1e15; // 0.001 ETH equivalent

    // Native USDC, WETH on Optimism (defaults)
    address constant DEFAULT_USDC_OP = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address constant DEFAULT_WETH_OP = 0x4200000000000000000000000000000000000006;

    struct ScriptParams {
        GPv2Settlement settlement;
        address safe;
        IERC20[] tokens;
        uint256 minTotalWei;
    }

    function run() public {
        ScriptParams memory params = paramsFromEnv();
        runWith(params);
    }

    function paramsFromEnv() internal view returns (ScriptParams memory params) {
        params.settlement = GPv2Settlement(payable(vm.envOr("SETTLEMENT", DEFAULT_SETTLEMENT)));
        params.safe = vm.envOr("SAFE", DEFAULT_SAFE);
        params.minTotalWei = vm.envOr("MIN_TOTAL_WEI", DEFAULT_MIN_TOTAL_WEI);

        // TOKENS is a comma-separated list — fall back to defaults (USDC + WETH).
        try vm.envString("TOKENS") returns (string memory tokensStr) {
            params.tokens = _parseTokenList(tokensStr);
        } catch {
            params.tokens = new IERC20[](2);
            params.tokens[0] = IERC20(DEFAULT_USDC_OP);
            params.tokens[1] = IERC20(DEFAULT_WETH_OP);
        }
    }

    function runWith(ScriptParams memory params) public {
        console.log("=== Settlement Buffer Sweep ===");
        console.log("Settlement:", address(params.settlement));
        console.log("Safe:      ", params.safe);
        console.log("Tokens:    ", params.tokens.length);

        // Compute balances and assemble post-interactions for non-zero ones.
        // GPv2Settlement.settle() takes interactions as Data[][3]; we use only
        // the post-interactions slot (index 2). pre and intra are empty arrays.
        GPv2Interaction.Data[] memory postInteractions = _buildSweepInteractions(
            params.settlement,
            params.safe,
            params.tokens
        );

        if (postInteractions.length == 0) {
            console.log("No tokens with balance > 0. Skipping.");
            return;
        }

        // Audit MED-2 (codex + sharp-edges 2026-05-20): the previous shape
        // logged a warning but still broadcast even when below threshold.
        // That gates against operator error (broadcasting a sweep that
        // costs more in gas than it captures). Hard-abort unless override
        // is explicitly set.
        //
        // 2026-05-20 audit follow-up: the prior check inspected ONLY the
        // WETH balance, which meant a sweep targeting USDC (or any other
        // configured token) was blocked even when that token had a
        // substantial accumulated balance. Now: compute the MAX balance
        // across the configured token list and gate on that. The
        // semantic is "if no configured token has balance >= threshold,
        // the sweep isn't worth the gas". Imperfect across mixed
        // decimals (1e18 WETH-wei vs 1e6 USDC-base) but a pragmatic
        // improvement over the WETH-only check; operator sets the
        // threshold knowing the bucket they're targeting.
        uint256 maxBalance = 0;
        address maxBalanceToken = address(0);
        for (uint256 i = 0; i < params.tokens.length; i++) {
            uint256 b = params.tokens[i].balanceOf(address(params.settlement));
            if (b > maxBalance) {
                maxBalance = b;
                maxBalanceToken = address(params.tokens[i]);
            }
        }
        bool forceBelowThreshold = vm.envOr("FORCE_SWEEP_BELOW_THRESHOLD", false);
        if (maxBalance < params.minTotalWei && !forceBelowThreshold) {
            console.log("ABORT: no configured token has balance >= threshold.");
            console.log("  max balance:    ", maxBalance);
            console.log("  max balance token:", maxBalanceToken);
            console.log("  threshold:      ", params.minTotalWei);
            console.log("Set FORCE_SWEEP_BELOW_THRESHOLD=1 to override.");
            revert("BelowThreshold");
        }

        // Build empty trade arrays
        IERC20[] memory emptyTokens = new IERC20[](0);
        uint256[] memory emptyPrices = new uint256[](0);
        GPv2Trade.Data[] memory emptyTrades = new GPv2Trade.Data[](0);

        // Build the interactions argument: [pre=[], intra=[], post=sweep]
        GPv2Interaction.Data[][3] memory interactions;
        interactions[0] = new GPv2Interaction.Data[](0);
        interactions[1] = new GPv2Interaction.Data[](0);
        interactions[2] = postInteractions;

        console.log("Broadcasting sweep with", postInteractions.length, "transfer interaction(s)...");
        vm.startBroadcast();
        params.settlement.settle(emptyTokens, emptyPrices, emptyTrades, interactions);
        vm.stopBroadcast();
        console.log("Sweep tx submitted.");
    }

    function _buildSweepInteractions(
        GPv2Settlement settlement,
        address safe,
        IERC20[] memory tokens
    ) internal view returns (GPv2Interaction.Data[] memory) {
        // 2026-05-20 audit follow-up: the prior implementation called
        // `tokens[i].balanceOf(settlement)` TWICE per token (once to
        // count, once to encode the transfer). Between the two calls,
        // a concurrent fill on the settlement contract could change
        // balances; worse, if a token's balance dropped to zero
        // between passes, `count` would over-allocate and leave
        // uninitialized (target=0x0, value=0, callData=0x) entries in
        // the result array — the final `settlement.settle(...)` would
        // then attempt to call 0x0 and revert the entire sweep.
        //
        // Fix: snapshot all balances into a memory array once, then
        // build the interactions from the snapshot. Single source of
        // truth, no TOCTOU window.
        uint256[] memory balances = new uint256[](tokens.length);
        uint256 count = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = tokens[i].balanceOf(address(settlement));
            if (balances[i] > 0) {
                count++;
                console.log("  token", address(tokens[i]), "balance:", balances[i]);
            } else {
                console.log("  token", address(tokens[i]), "balance: 0 (skip)");
            }
        }

        // Build the interactions array from the snapshot.
        GPv2Interaction.Data[] memory result = new GPv2Interaction.Data[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (balances[i] == 0) continue;
            result[idx] = GPv2Interaction.Data({
                target: address(tokens[i]),
                value: 0,
                callData: abi.encodeWithSelector(IERC20.transfer.selector, safe, balances[i])
            });
            idx++;
        }
        return result;
    }

    function _getBalanceForToken(
        GPv2Settlement settlement,
        IERC20[] memory tokens,
        address target
    ) internal view returns (uint256) {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (address(tokens[i]) == target) {
                return tokens[i].balanceOf(address(settlement));
            }
        }
        return 0;
    }

    function _parseTokenList(string memory s) internal pure returns (IERC20[] memory) {
        // Comma-separated 0x-prefixed addresses. Defensive but minimal: this
        // is operator-controlled input so we don't need to harden against
        // adversarial parsing.
        bytes memory b = bytes(s);
        // Count commas + 1 = number of tokens.
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") n++;
        }
        IERC20[] memory out = new IERC20[](n);
        uint256 start = 0;
        uint256 k = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                bytes memory chunk = new bytes(i - start);
                for (uint256 j = 0; j < chunk.length; j++) chunk[j] = b[start + j];
                out[k] = IERC20(_parseAddress(string(chunk)));
                k++;
                start = i + 1;
            }
        }
        return out;
    }

    function _parseAddress(string memory s) internal pure returns (address) {
        // vm.parseAddress is the cleanest path but we keep this dependency-
        // light. The script is operator-internal; address parsing here is
        // unguarded and intentional.
        return vm.parseAddress(s);
    }
}
