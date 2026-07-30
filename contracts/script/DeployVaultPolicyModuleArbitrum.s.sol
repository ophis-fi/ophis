// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console2} from "forge-std/Script.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

/// @notice Deploys the vault policy factory + a module for a trial vault on
/// Arbitrum One (42161). Env: VAULT_SAFE, VAULT_CURATOR, VAULT_APPDATA_HASH,
/// optional VAULT_CAP (default 250e18). CoW-hosted: canonical settlement +
/// relayer, Ophis partner fee via the pinned appData. Addresses verified
/// against live Arbitrum state (see the Arbitrum fork preflight).
contract DeployVaultPolicyModuleArbitrum is Script {
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41; // canonical
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // native USDC, 6dp
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // 18dp
    address constant USDC_FEED = 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3; // USDC/USD, 8dp
    address constant ETH_FEED = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612; // ETH/USD, 8dp
    address constant SEQ_FEED = 0xFdB631F5EE196F0ed6FAa767959853A9F217697D; // L2 uptime

    // Arbitrum's ETH/USD feed is deviation-driven (0.05%) and updates every few
    // minutes in practice (measured on-chain: ~2-6 min/round), so the tight 2h
    // window shared with the other chains is safe and keeps the stale-price
    // envelope small; a false-stale is a harmless fail-closed revert (retry).
    // USDC/USD is a 24h-heartbeat stable feed and needs 24h + buffer.
    uint256 constant ETH_STALENESS = 2 hours;
    uint256 constant USDC_STALENESS = 26 hours;
    uint256 constant USDC_MIN_PRICE18 = 25e16;
    uint256 constant USDC_MAX_PRICE18 = 4e18;
    uint256 constant ETH_MIN_PRICE18 = 500e18;
    uint256 constant ETH_MAX_PRICE18 = 8000e18;

    function run() external {
        // Audit lead: cheap wrong-RPC guard (the feed liveness probe also fails
        // closed cross-chain, but this reverts with a clear reason first).
        require(block.chainid == 42161, "wrong chain");
        address safe = vm.envAddress("VAULT_SAFE");
        address curator = vm.envAddress("VAULT_CURATOR");
        bytes32 appDataHash = vm.envBytes32("VAULT_APPDATA_HASH");
        uint256 cap = vm.envOr("VAULT_CAP", uint256(250e18));

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(
            USDC, IAggregatorV3(USDC_FEED), USDC_STALENESS, USDC_MIN_PRICE18, USDC_MAX_PRICE18
        );
        tokens[1] = OphisVaultPolicyModule.TokenFeed(
            WETH, IAggregatorV3(ETH_FEED), ETH_STALENESS, ETH_MIN_PRICE18, ETH_MAX_PRICE18
        );

        OphisVaultPolicyModule.ModuleConfig memory cfg = OphisVaultPolicyModule.ModuleConfig({
            safe: ISafe(safe),
            settlement: IGPv2Settlement(SETTLEMENT),
            curator: curator,
            appDataHash: appDataHash,
            maxSlippageBps: 50,
            // Headroom over @ophis/safe-swap's default 1800s order TTL (see the
            // OP/Base scripts).
            maxTtl: 1980,
            dailyUsdTurnoverCap: cap,
            sequencerUptimeFeed: IAggregatorV3(SEQ_FEED),
            allowNoSequencerFeed: false,
            sequencerGracePeriod: 1 hours,
            tokens: tokens
        });

        vm.startBroadcast();
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        OphisVaultPolicyModule module = factory.deploy(cfg);
        vm.stopBroadcast();

        console2.log("factory:", address(factory));
        console2.log("module :", address(module));
        console2.log("relayer:", module.relayer());
    }
}
