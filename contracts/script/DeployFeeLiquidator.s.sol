// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Script, console} from "forge-std/Script.sol";

import {GPv2Settlement} from "../src/contracts/GPv2Settlement.sol";
import {OphisFeeLiquidator} from "../src/contracts/OphisFeeLiquidator.sol";

/// @title Deploy OphisFeeLiquidator
///
/// Deploys the fee-treasury liquidator with the sweep-only launch posture
/// (decision 52): the venue allowlist ships EMPTY, so `consolidate` is inert
/// until the owner Safe enables a venue + output token later. Deployment
/// grants NO authority by itself, the contract only becomes operational
/// after the 24h Timelock `addSolver` ceremony (see
/// docs/operations/fee-treasury-ops-runbook.md). The deployer EOA holds no
/// role afterwards.
///
/// Inputs (env vars, all optional except LIQUIDATOR on mainnet):
///   SETTLEMENT   Settlement address       (default: Ophis OP mainnet)
///   FEE_SAFE     Fee Safe                 (default: 0x858f0F5e…CeF8)
///   OWNER        Protocol Safe            (default: 0xe049a6…01cF)
///   LIQUIDATOR   Fee-ops key address      (default: address(0) = deploy
///                paused; owner enables later via setLiquidator)
///
/// Sepolia rehearsal overrides SETTLEMENT/FEE_SAFE/OWNER/LIQUIDATOR with the
/// rehearsal addresses, never rely on the mainnet defaults there.
///
/// Usage:
///   forge script DeployFeeLiquidator --rpc-url $RPC --sender $EOA     # dry
///   PRIVATE_KEY=... forge script DeployFeeLiquidator \
///     --rpc-url $RPC --broadcast                                      # live
contract DeployFeeLiquidator is Script {
    address internal constant DEFAULT_SETTLEMENT = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    address internal constant DEFAULT_FEE_SAFE = 0x858f0F5eE954846D47155F5203c04aF1819eCeF8;
    address internal constant DEFAULT_OWNER = 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF;

    function run() public returns (OphisFeeLiquidator liquidator) {
        GPv2Settlement settlement = GPv2Settlement(payable(vm.envOr("SETTLEMENT", DEFAULT_SETTLEMENT)));
        address payable feeSafe = payable(vm.envOr("FEE_SAFE", DEFAULT_FEE_SAFE));
        address owner = vm.envOr("OWNER", DEFAULT_OWNER);
        address opsKey = vm.envOr("LIQUIDATOR", address(0));

        // The settlement address must actually be a GPv2Settlement on this
        // chain, a wrong SETTLEMENT env (e.g. mainnet default on Sepolia)
        // dies here instead of producing a bricked deployment.
        address authenticator = address(settlement.authenticator());
        require(authenticator != address(0), "DeployFeeLiquidator: settlement has no authenticator");

        console.log("=== OphisFeeLiquidator deploy ===");
        console.log("Settlement:   ", address(settlement));
        console.log("Authenticator:", authenticator);
        console.log("Fee Safe:     ", feeSafe);
        console.log("Owner (Safe): ", owner);
        console.log("Liquidator:   ", opsKey);
        if (opsKey == address(0)) {
            console.log("NOTE: liquidator unset -- ops-key path deploys PAUSED;");
            console.log("      enable later with a Safe tx: setLiquidator(opsKey)");
        }

        vm.startBroadcast();
        liquidator = new OphisFeeLiquidator(settlement, feeSafe, owner, opsKey);
        vm.stopBroadcast();

        console.log("Deployed OphisFeeLiquidator at:", address(liquidator));
        console.log("Next steps (owner ceremonies, see fee-treasury-ops-runbook.md):");
        console.log("  1. record the address in contracts/deployments/<network>/ + networks.json");
        console.log("  2. schedule the 24h Timelock addSolver(liquidator) ceremony");
        console.log("  3. after execution, verify authenticator.isSolver(liquidator)");
    }
}
