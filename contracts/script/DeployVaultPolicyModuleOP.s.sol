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

    // ETH/USD updates on a short (deviation-driven, ~20min-1h) heartbeat, so a
    // few hours is a safe-yet-tight window for the volatile leg; USDC/USD is a
    // 24h-heartbeat stable feed and needs 24h + a buffer.
    uint256 constant ETH_STALENESS = 6 hours;
    uint256 constant USDC_STALENESS = 26 hours;

    function run() external {
        address safe = vm.envAddress("VAULT_SAFE");
        address curator = vm.envAddress("VAULT_CURATOR");
        bytes32 appDataHash = vm.envBytes32("VAULT_APPDATA_HASH");
        uint256 cap = vm.envOr("VAULT_CAP", uint256(250e18));

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(USDC, IAggregatorV3(USDC_FEED), USDC_STALENESS);
        tokens[1] = OphisVaultPolicyModule.TokenFeed(WETH, IAggregatorV3(ETH_FEED), ETH_STALENESS);

        OphisVaultPolicyModule.ModuleConfig memory cfg = OphisVaultPolicyModule.ModuleConfig({
            safe: ISafe(safe),
            settlement: IGPv2Settlement(SETTLEMENT),
            curator: curator,
            appDataHash: appDataHash,
            maxSlippageBps: 50,
            maxTtl: 1800,
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
