// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console2} from "forge-std/Script.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

/// @notice Deploys the vault policy factory + a module for a trial vault on
/// Optimism (10). Env: VAULT_SAFE, VAULT_CURATOR, VAULT_APPDATA_HASH, optional
/// VAULT_CAP (default 250e18). Feeds/settlement/tokens hardcoded to addresses
/// verified against live OP state (see the OP fork preflight test). Unlike
/// Unichain, OP's Chainlink feeds are 8-decimal and ETH/USD updates far more
/// often than the 24h-heartbeat stables, so maxStaleness is sized PER feed.
contract DeployVaultPolicyModuleOP is Script {
    // Ophis self-hosted OP settlement (NON-canonical; verified on-chain). The
    // module reads its relayer + domain separator from here at construction.
    address constant SETTLEMENT = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    address constant USDC = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85; // native USDC, 6dp
    address constant WETH = 0x4200000000000000000000000000000000000006; // 18dp
    address constant USDC_FEED = 0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3; // USDC/USD, 8dp
    address constant ETH_FEED = 0x13e3Ee699D1909E989722E753853AE30b17e08c5; // ETH/USD, 8dp
    address constant SEQ_FEED = 0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389; // L2 uptime

    // ETH/USD updates on a short (deviation-driven, ~20min heartbeat) cadence:
    // 2h = several heartbeats of buffer while keeping the volatile-leg stale-
    // price envelope tight (audit lead: size tight to the heartbeat). USDC/USD
    // is a 24h-heartbeat stable feed and needs 24h + a buffer.
    uint256 constant ETH_STALENESS = 2 hours;
    uint256 constant USDC_STALENESS = 26 hours;
    uint256 constant USDC_MIN_PRICE18 = 25e16;
    uint256 constant USDC_MAX_PRICE18 = 4e18;
    uint256 constant ETH_MIN_PRICE18 = 500e18;
    uint256 constant ETH_MAX_PRICE18 = 8000e18;

    function run() external {
        // Audit lead: cheap wrong-RPC guard (the feed liveness probe also fails
        // closed cross-chain, but this reverts with a clear reason first).
        require(block.chainid == 10, "wrong chain");
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
            // Headroom over @ophis/safe-swap's fixed 1800s order TTL: the module
            // checks validTo against the L2 block timestamp, which can lag the
            // builder's wall clock, so maxTtl == 1800 leaves zero slack and
            // reverts BadValidTo. Actual price exposure stays the order's 1800s
            // validTo; this is only the ceiling on a curator-craftable TTL.
            maxTtl: 1980,
            dailyUsdTurnoverCap: cap,
            sequencerUptimeFeed: IAggregatorV3(SEQ_FEED),
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
