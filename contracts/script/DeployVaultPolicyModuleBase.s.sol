// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console2} from "forge-std/Script.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

/// @notice Deploys the vault policy factory + a module for a trial vault on Base
/// (8453). Env: VAULT_SAFE, VAULT_CURATOR, VAULT_APPDATA_HASH, optional VAULT_CAP
/// (default 250e18). Base is CoW-HOSTED (sovereign stack paused), so orders
/// settle through the CANONICAL GPv2 settlement + relayer with the Ophis partner
/// fee carried in the pinned appData; the module reads the canonical relayer +
/// domain separator from the settlement. Addresses verified against live Base
/// state (see the Base fork preflight test).
contract DeployVaultPolicyModuleBase is Script {
    // Canonical CoW GPv2 settlement (CoW-hosted chains). Module reads its
    // canonical relayer + domain separator at construction.
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // native USDC, 6dp
    address constant WETH = 0x4200000000000000000000000000000000000006; // 18dp
    address constant USDC_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B; // USDC/USD, 8dp
    address constant ETH_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70; // ETH/USD, 8dp
    address constant SEQ_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433; // L2 uptime

    // ETH/USD on Base updates on a short (deviation-driven) heartbeat; USDC/USD
    // is a 24h-heartbeat stable feed.
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
