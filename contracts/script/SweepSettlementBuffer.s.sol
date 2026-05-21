// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console} from "forge-std/Script.sol";

import {GPv2Settlement} from "../src/contracts/GPv2Settlement.sol";
import {GPv2Authentication} from "../src/contracts/interfaces/GPv2Authentication.sol";
import {GPv2Interaction} from "../src/contracts/libraries/GPv2Interaction.sol";
import {GPv2Trade} from "../src/contracts/libraries/GPv2Trade.sol";
import {IERC20} from "../src/contracts/interfaces/IERC20.sol";

/// @title Sweep Settlement Buffer to Recipient Safe
///
/// Calls `Settlement.settle()` with empty trades and a single batch of post-
/// interactions that transfer the Settlement contract's accumulated balances
/// (CIP-75 partner-fee buffer) to a designated recipient.
///
/// On the Ophis OP fork at `0x310784c7…`, CIP-75 partner-fee reduces the
/// user's executed buy amount by the calculated fee, but does NOT atomically
/// transfer to `partnerFee.recipient`. The fee accumulates in Settlement.
/// Without this sweep, the buffer is recycled into future-trader price
/// improvement (CoW's default behavior), which is functionally equivalent
/// to ZERO Ophis revenue.
///
/// This is option B1 from `docs/audits/2026-05-20-cip75-partner-fee-bypass.md`.
///
/// ## 2026-05-22 ToB-suite audit hardening (HIGH-1, HIGH-2, HIGH-3)
///
/// **HIGH-1** — the previous single `MIN_TOTAL_WEI` threshold was
/// decimals-blind across mixed-decimal tokens. With `MIN_TOTAL_WEI=1e15`,
/// USDC (6 decimals) needed 10^9 base units = $1B before the sweep would
/// fire, while WETH (18 decimals) triggered at 0.001 ETH. USDC partner-fees
/// could accumulate indefinitely without ever crossing the threshold —
/// a silent revenue bug. Replaced with PER-TOKEN base-unit thresholds plus
/// a separate ETH threshold; defaults map to ~$10 each on OP at the time
/// of writing.
///
/// **HIGH-2** — the previous script did NOT pre-verify that the broadcaster
/// EOA is currently allowlisted in the AllowListAuthentication proxy. If
/// the Safe revoked the solver registration between the AllowList vote
/// and the sweep run, `settle()` would revert with "GPv2: not a solver"
/// AFTER the broadcast — wasting gas AND leaking sweep intent into the
/// public mempool (front-runnable). Now we read
/// `Settlement.authenticator().isSolver(broadcaster)` BEFORE the broadcast
/// and revert locally if the answer is false.
///
/// **HIGH-3** — the previous script swept ONLY ERC20 balances, not native
/// ETH. Settlement has an open `receive()` and accumulates ETH from
/// sequencer-fee refunds and direct-buy 0xEee…EeE order refunds. That ETH
/// stayed locked indefinitely. Now we also detect `Settlement.balance > 0`
/// and append a value-bearing interaction that transfers the ETH to the
/// Safe (Settlement forwards `value` to the target via
/// `target.call{value: interaction.value}(callData)`).
///
/// Inputs (env vars):
///   SETTLEMENT          Settlement contract address (default: Ophis OP)
///   SAFE                Recipient Safe (default: 0x858f0F5e…CeF8)
///   TOKENS              Comma-separated ERC20 addresses to sweep
///   MIN_BASE_UNITS      Comma-separated per-token base-unit thresholds
///                       (same length as TOKENS, both default to USDC+WETH
///                       with $10-equivalent thresholds on OP)
///   MIN_ETH_WEI         Native-ETH threshold in wei (default: 3e15 ≈ $10
///                       at $3500/ETH)
///
/// Usage:
///   forge script SweepSettlementBuffer --rpc-url $RPC --sender $EOA
///
///   PRIVATE_KEY=... forge script SweepSettlementBuffer \
///     --rpc-url $RPC --broadcast
contract SweepSettlementBuffer is Script {
    // Ophis OP defaults
    address constant DEFAULT_SETTLEMENT = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    address constant DEFAULT_SAFE = 0x858f0F5eE954846D47155F5203c04aF1819eCeF8;

    // Native USDC, WETH on Optimism (defaults)
    address constant DEFAULT_USDC_OP = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address constant DEFAULT_WETH_OP = 0x4200000000000000000000000000000000000006;

    // Per-token default thresholds, denominated in each token's base units.
    // Picked to be roughly equivalent to $10 each on OP at the time of writing.
    // - USDC is 6 decimals, $1 per token → $10 = 10 * 1e6 = 1e7 base units.
    // - WETH is 18 decimals; at $3500/ETH → $10 ≈ 0.00286 ETH = 2.86e15 wei.
    //   We round up to 3e15 for a conservative ~$10.50 threshold.
    // Operator override via env (MIN_BASE_UNITS) when token mix differs.
    uint256 constant DEFAULT_MIN_USDC_BASE_UNITS = 1e7;
    uint256 constant DEFAULT_MIN_WETH_BASE_UNITS = 3e15;
    // HIGH-3: native-ETH threshold (same magnitude as WETH default).
    uint256 constant DEFAULT_MIN_ETH_WEI = 3e15;
    // Fallback per-token threshold for tokens not in the known-defaults
    // table (operator did not provide MIN_BASE_UNITS). Conservative: equals
    // the legacy MIN_TOTAL_WEI default. Operators are expected to override
    // when sweeping non-USDC/WETH balances.
    uint256 constant DEFAULT_MIN_UNKNOWN_BASE_UNITS = 1e15;

    struct ScriptParams {
        GPv2Settlement settlement;
        address safe;
        IERC20[] tokens;
        // HIGH-1: per-token threshold in base units. Same length as tokens.
        uint256[] minBaseUnits;
        // HIGH-3: native-ETH threshold in wei.
        uint256 minEthWei;
    }

    function run() public {
        ScriptParams memory params = paramsFromEnv();
        runWith(params);
    }

    function paramsFromEnv() internal view returns (ScriptParams memory params) {
        params.settlement = GPv2Settlement(payable(vm.envOr("SETTLEMENT", DEFAULT_SETTLEMENT)));
        params.safe = vm.envOr("SAFE", DEFAULT_SAFE);
        params.minEthWei = vm.envOr("MIN_ETH_WEI", DEFAULT_MIN_ETH_WEI);

        // TOKENS is a comma-separated list — fall back to defaults (USDC + WETH).
        try vm.envString("TOKENS") returns (string memory tokensStr) {
            params.tokens = _parseTokenList(tokensStr);
        } catch {
            params.tokens = new IERC20[](2);
            params.tokens[0] = IERC20(DEFAULT_USDC_OP);
            params.tokens[1] = IERC20(DEFAULT_WETH_OP);
        }

        // HIGH-1: per-token thresholds. MIN_BASE_UNITS is a comma-separated
        // list aligned 1:1 with TOKENS. When unset, fall back to the
        // known-defaults table by address; for unknown addresses use the
        // conservative legacy threshold.
        try vm.envString("MIN_BASE_UNITS") returns (string memory minStr) {
            params.minBaseUnits = _parseUintList(minStr);
            require(
                params.minBaseUnits.length == params.tokens.length,
                "SweepScript: MIN_BASE_UNITS length mismatch with TOKENS"
            );
        } catch {
            params.minBaseUnits = new uint256[](params.tokens.length);
            for (uint256 i = 0; i < params.tokens.length; i++) {
                params.minBaseUnits[i] = _defaultThresholdFor(address(params.tokens[i]));
            }
        }
    }

    function _defaultThresholdFor(address token) internal pure returns (uint256) {
        if (token == DEFAULT_USDC_OP) return DEFAULT_MIN_USDC_BASE_UNITS;
        if (token == DEFAULT_WETH_OP) return DEFAULT_MIN_WETH_BASE_UNITS;
        return DEFAULT_MIN_UNKNOWN_BASE_UNITS;
    }

    function runWith(ScriptParams memory params) public {
        console.log("=== Settlement Buffer Sweep ===");
        console.log("Settlement:", address(params.settlement));
        console.log("Safe:      ", params.safe);
        console.log("Tokens:    ", params.tokens.length);

        // HIGH-2 fix: pre-broadcast allowlist check.
        // forge passes --sender as msg.sender during script execution;
        // PRIVATE_KEY env (if set) overrides via vm.addr. Determine the
        // broadcaster address, then assert it's currently allowlisted by
        // the Settlement's on-chain authenticator. Reverting here costs
        // zero gas + does NOT leak intent into the public mempool.
        address broadcaster;
        try vm.envUint("PRIVATE_KEY") returns (uint256 pk) {
            broadcaster = vm.addr(pk);
        } catch {
            broadcaster = msg.sender;
        }
        GPv2Authentication auth = params.settlement.authenticator();
        require(
            auth.isSolver(broadcaster),
            "SweepScript: broadcaster not in solver allowlist (run with --sender or PRIVATE_KEY of allowlisted EOA)"
        );
        console.log("Broadcaster:", broadcaster, "(allowlisted)");

        // Compute balances and assemble post-interactions for non-zero ones.
        // GPv2Settlement.settle() takes interactions as Data[][3]; we use only
        // the post-interactions slot (index 2). pre and intra are empty arrays.
        GPv2Interaction.Data[] memory postInteractions = _buildSweepInteractions(
            params.settlement,
            params.safe,
            params.tokens,
            params.minBaseUnits,
            params.minEthWei
        );

        if (postInteractions.length == 0) {
            console.log(
                "No tokens with balance >= threshold and no ETH > MIN_ETH_WEI. Skipping."
            );
            return;
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

    /// @dev Build the sweep interaction list — one entry per token whose
    /// balance meets its configured threshold, plus an optional ETH-transfer
    /// entry if the Settlement's native-ETH balance meets `minEthWei`.
    ///
    /// Snapshot pattern (2026-05-20 audit follow-up): we read every balance
    /// ONCE into a memory array, then build interactions from that snapshot.
    /// Avoids the TOCTOU window where a concurrent fill could change the
    /// balance between two `balanceOf(settlement)` reads in the original
    /// implementation.
    function _buildSweepInteractions(
        GPv2Settlement settlement,
        address safe,
        IERC20[] memory tokens,
        uint256[] memory minBaseUnits,
        uint256 minEthWei
    ) internal view returns (GPv2Interaction.Data[] memory) {
        // Snapshot ERC20 balances.
        uint256[] memory balances = new uint256[](tokens.length);
        uint256 erc20Count = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = tokens[i].balanceOf(address(settlement));
            if (balances[i] >= minBaseUnits[i]) {
                erc20Count++;
                console.log("  token", address(tokens[i]), "balance:", balances[i]);
            } else if (balances[i] > 0) {
                console.log(
                    "  token",
                    address(tokens[i]),
                    "balance below threshold (skip):",
                    balances[i]
                );
            } else {
                console.log("  token", address(tokens[i]), "balance: 0 (skip)");
            }
        }

        // HIGH-3 fix: snapshot native ETH balance + check threshold.
        uint256 ethBalance = address(settlement).balance;
        uint256 ethCount = 0;
        if (ethBalance >= minEthWei) {
            ethCount = 1;
            console.log("  native ETH balance:", ethBalance, "(will sweep)");
        } else if (ethBalance > 0) {
            console.log("  native ETH balance below threshold (skip):", ethBalance);
        }

        GPv2Interaction.Data[] memory result = new GPv2Interaction.Data[](erc20Count + ethCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (balances[i] < minBaseUnits[i]) continue;
            result[idx] = GPv2Interaction.Data({
                target: address(tokens[i]),
                value: 0,
                callData: abi.encodeWithSelector(IERC20.transfer.selector, safe, balances[i])
            });
            idx++;
        }
        if (ethCount == 1) {
            // HIGH-3 fix: native ETH sweep via value-bearing call to Safe.
            // GPv2Interaction.execute uses `target.call{value: value}(callData)`,
            // so an empty callData with `value: ethBalance` performs a plain
            // ETH transfer. Settlement is `payable` and holds the ETH; the
            // call forwards it to `safe`.
            result[idx] = GPv2Interaction.Data({
                target: safe,
                value: ethBalance,
                callData: ""
            });
            idx++;
        }
        return result;
    }

    function _parseTokenList(string memory s) internal pure returns (IERC20[] memory) {
        // Comma-separated 0x-prefixed addresses. Defensive but minimal: this
        // is operator-controlled input so we don't need to harden against
        // adversarial parsing.
        bytes memory b = bytes(s);
        if (b.length == 0) return new IERC20[](0);
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
                out[k] = IERC20(vm.parseAddress(string(chunk)));
                k++;
                start = i + 1;
            }
        }
        return out;
    }

    /// @dev Same comma-separated parser as `_parseTokenList` but for uint256
    /// base-unit values (HIGH-1: per-token threshold list).
    function _parseUintList(string memory s) internal pure returns (uint256[] memory) {
        bytes memory b = bytes(s);
        if (b.length == 0) return new uint256[](0);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") n++;
        }
        uint256[] memory out = new uint256[](n);
        uint256 start = 0;
        uint256 k = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                bytes memory chunk = new bytes(i - start);
                for (uint256 j = 0; j < chunk.length; j++) chunk[j] = b[start + j];
                out[k] = vm.parseUint(string(chunk));
                k++;
                start = i + 1;
            }
        }
        return out;
    }
}
