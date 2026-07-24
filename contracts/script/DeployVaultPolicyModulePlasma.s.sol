// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console2} from "forge-std/Script.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

/// @notice Deploys the vault policy factory + a module for a trial vault on
/// Plasma (9745). Env: VAULT_SAFE, VAULT_CURATOR, VAULT_APPDATA_HASH, optional
/// VAULT_CAP (default 250e18). CoW-hosted: canonical settlement + relayer, Ophis
/// partner fee via the pinned appData. Plasma is an L1 (PlasmaBFT, not an
/// OP-stack rollup) with no Chainlink L2 sequencer-uptime feed, so the sequencer
/// gate is disabled (address(0), grace 0; the module constructor requires they
/// be zero together). Plasma has no USDC, so the allowlist is the native pair
/// WXPL (wrapped-native, 18dp) + USDT0 (6dp). Both feeds carry a 24h heartbeat,
/// so staleness is 26h on BOTH legs (the Unichain posture, not Ethereum's tight
/// 2h volatile leg). Addresses verified against live Plasma state (see the
/// Plasma fork preflight).
contract DeployVaultPolicyModulePlasma is Script {
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41; // canonical
    address constant USDT0 = 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb; // 6dp
    address constant WXPL = 0x6100E367285b01F48D07953803A2d8dCA5D19873; // 18dp (wrapped-native)
    address constant USDT0_FEED = 0x3205B49b3C8c5D593589e1e70567993f72C5F845; // USDT0/USD, 8dp
    address constant XPL_FEED = 0xF932477C37715aE6657Ab884414Bd9876FE3f750; // XPL/USD, 8dp

    // Both Plasma feeds have a 24h heartbeat, so 26h = heartbeat + a 2h buffer
    // keeps the deploy-time liveness probe from reverting on a feed that has
    // simply not moved past its heartbeat yet (mirrors Unichain, whose feeds are
    // also 24h-heartbeat; Ethereum's 2h ETH leg does not apply here).
    uint256 constant USDT0_STALENESS = 26 hours;
    uint256 constant XPL_STALENESS = 26 hours;

    function run() external {
        // Audit lead: cheap wrong-RPC guard (the feed liveness probe also fails
        // closed cross-chain, but this reverts with a clear reason first).
        require(block.chainid == 9745, "wrong chain");
        address safe = vm.envAddress("VAULT_SAFE");
        address curator = vm.envAddress("VAULT_CURATOR");
        bytes32 appDataHash = vm.envBytes32("VAULT_APPDATA_HASH");
        uint256 cap = vm.envOr("VAULT_CAP", uint256(250e18));

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(USDT0, IAggregatorV3(USDT0_FEED), USDT0_STALENESS);
        tokens[1] = OphisVaultPolicyModule.TokenFeed(WXPL, IAggregatorV3(XPL_FEED), XPL_STALENESS);

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
