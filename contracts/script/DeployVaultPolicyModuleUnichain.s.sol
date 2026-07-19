// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console2} from "forge-std/Script.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

/// @notice Deploys the vault policy factory + a module for a trial vault on
/// Unichain (130). Env: VAULT_SAFE, VAULT_CURATOR, VAULT_APPDATA_HASH,
/// optional VAULT_CAP (default 250e18). Feeds/settlement/tokens hardcoded to
/// verified Unichain addresses.
contract DeployVaultPolicyModuleUnichain is Script {
    address constant SETTLEMENT = 0x108A678716e5E1776036eF044CAB7064226F714E;
    address constant USDC = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC_FEED = 0xbd1cD1518eFB92a92100da62D4C488c810dFd75b; // USDC/USD 18dp
    address constant ETH_FEED = 0xBcE70e194940a157f3A80566505a7E96f5238CCa; // ETH/USD 18dp
    address constant SEQ_FEED = 0x495639D9914e7D270c5dCC641BfB1d807423F813; // L2 uptime

    function run() external {
        // Audit lead: cheap wrong-RPC guard (the feed liveness probe also fails
        // closed cross-chain, but this reverts with a clear reason first).
        require(block.chainid == 130, "wrong chain");
        address safe = vm.envAddress("VAULT_SAFE");
        address curator = vm.envAddress("VAULT_CURATOR");
        bytes32 appDataHash = vm.envBytes32("VAULT_APPDATA_HASH");
        uint256 cap = vm.envOr("VAULT_CAP", uint256(250e18));

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(USDC, IAggregatorV3(USDC_FEED), 26 hours);
        tokens[1] = OphisVaultPolicyModule.TokenFeed(WETH, IAggregatorV3(ETH_FEED), 26 hours);

        OphisVaultPolicyModule.ModuleConfig memory cfg = OphisVaultPolicyModule.ModuleConfig({
            safe: ISafe(safe),
            settlement: IGPv2Settlement(SETTLEMENT),
            curator: curator,
            appDataHash: appDataHash,
            maxSlippageBps: 50,
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
