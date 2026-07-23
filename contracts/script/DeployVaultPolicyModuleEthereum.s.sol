// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console2} from "forge-std/Script.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

/// @notice Deploys the vault policy factory + a module for a trial vault on
/// Ethereum mainnet (1). Env: VAULT_SAFE, VAULT_CURATOR, VAULT_APPDATA_HASH,
/// optional VAULT_CAP (default 250e18). CoW-hosted: canonical settlement +
/// relayer, Ophis partner fee via the pinned appData. Ethereum is an L1 - there
/// is NO sequencer-uptime feed, so the sequencer gate is disabled (address(0),
/// grace 0; the module constructor requires they be zero together). Addresses
/// verified against live Ethereum state (see the Ethereum fork preflight).
contract DeployVaultPolicyModuleEthereum is Script {
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41; // canonical
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // 6dp
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // 18dp
    address constant USDC_FEED = 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6; // USDC/USD, 8dp
    address constant ETH_FEED = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419; // ETH/USD, 8dp

    // Ethereum ETH/USD has a 1h heartbeat (0.5% deviation): 2h = heartbeat + a
    // full missed round of buffer, keeping the volatile-leg stale-price envelope
    // tight (audit lead). USDC/USD is a 24h-heartbeat stable feed.
    uint256 constant ETH_STALENESS = 2 hours;
    uint256 constant USDC_STALENESS = 26 hours;

    function run() external {
        // Audit lead: cheap wrong-RPC guard (the feed liveness probe also fails
        // closed cross-chain, but this reverts with a clear reason first).
        require(block.chainid == 1, "wrong chain");
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
            // Headroom over @ophis/safe-swap's default 1800s order TTL (see the
            // OP/Base scripts): maxTtl == the order TTL leaves zero slack against
            // block-timestamp lag and reverts BadValidTo.
            maxTtl: 1980,
            dailyUsdTurnoverCap: cap,
            sequencerUptimeFeed: IAggregatorV3(address(0)), // L1: no sequencer gate
            sequencerGracePeriod: 0,
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
