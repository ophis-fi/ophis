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
/// OWNER and FEE_SAFE are IMMUTABLE in the contract: a wrong value here is
/// only fixable by redeploy. To keep an unrelated exported shell variable
/// from baking a hijacked owner into a mainnet deploy (audit MAJOR), the env
/// names are project-scoped (`OFL_*`), the mainnet defaults are gated on
/// `block.chainid == 10`, OWNER/FEE_SAFE must be contracts (Safes have code),
/// and the broadcast requires an explicit typed confirmation `OFL_CONFIRM=1`.
///
/// Inputs (project-scoped env vars):
///   OFL_SETTLEMENT   Settlement address   (default: Ophis OP mainnet, chain 10 only)
///   OFL_FEE_SAFE     Fee Safe             (default: 0x858f0F5e…CeF8, chain 10 only)
///   OFL_OWNER        Protocol Safe        (default: 0xe049a6…01cF, chain 10 only)
///   OFL_LIQUIDATOR   Fee-ops key address  (default: address(0) = deploy paused;
///                    owner enables later via setLiquidator)
///   OFL_CONFIRM      must equal "1" to actually broadcast (dry-run otherwise)
///
/// Sepolia rehearsal MUST pass all of OFL_SETTLEMENT/OFL_FEE_SAFE/OFL_OWNER
/// explicitly (the mainnet defaults refuse to resolve off chain 10).
///
/// Usage:
///   # dry-run (no broadcast; prints resolved args for review):
///   forge script DeployFeeLiquidator --rpc-url $RPC --sender $EOA
///   # live (only after reviewing the dry-run output):
///   OFL_CONFIRM=1 OFL_LIQUIDATOR=0x… PRIVATE_KEY=… \
///     forge script DeployFeeLiquidator --rpc-url $RPC --broadcast
contract DeployFeeLiquidator is Script {
    // Mainnet defaults are only valid on Optimism (chain 10). Off-chain-10
    // callers must pass every address explicitly.
    uint256 internal constant OP_MAINNET = 10;
    address internal constant DEFAULT_SETTLEMENT = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    address internal constant DEFAULT_FEE_SAFE = 0x858f0F5eE954846D47155F5203c04aF1819eCeF8;
    address internal constant DEFAULT_OWNER = 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF;

    function run() public returns (OphisFeeLiquidator liquidator) {
        GPv2Settlement settlement = GPv2Settlement(payable(_resolveSettlement()));
        address payable feeSafe = payable(_resolveMainnetGated("OFL_FEE_SAFE", DEFAULT_FEE_SAFE));
        address owner = _resolveMainnetGated("OFL_OWNER", DEFAULT_OWNER);
        address opsKey = vm.envOr("OFL_LIQUIDATOR", address(0));

        // The settlement must actually be a GPv2Settlement on this chain: a
        // wrong address dies here instead of bricking the deployment.
        address authenticator = address(settlement.authenticator());
        require(authenticator != address(0), "DeployFeeLiquidator: settlement has no authenticator");

        // OWNER and FEE_SAFE are immutable. On mainnet they MUST be contracts:
        // the protocol Safe and fee Safe both have code, while a fat-fingered
        // or hijacked EOA does not, so this catches the "leftover exported var
        // baked a wrong owner" class before it is welded in. Off mainnet
        // (rehearsal), operators legitimately use EOAs as stand-ins, so there
        // it is a loud warning, not a revert.
        require(owner != feeSafe, "DeployFeeLiquidator: OWNER == FEE_SAFE (likely a mistake)");
        if (block.chainid == OP_MAINNET) {
            require(_hasCode(owner), "DeployFeeLiquidator: OWNER has no code on mainnet (expected the Safe)");
            require(_hasCode(feeSafe), "DeployFeeLiquidator: FEE_SAFE has no code on mainnet (expected the Safe)");
        } else {
            if (!_hasCode(owner)) console.log("WARN: OWNER has no code (EOA). OK for rehearsal, NEVER on mainnet.");
            if (!_hasCode(feeSafe)) {
                console.log("WARN: FEE_SAFE has no code (EOA). OK for rehearsal, NEVER on mainnet.");
            }
        }

        bool confirmed = _isConfirmed();

        console.log("=== OphisFeeLiquidator deploy ===");
        console.log("Chain id:     ", block.chainid);
        console.log("Settlement:   ", address(settlement));
        console.log("Authenticator:", authenticator);
        console.log("Fee Safe:     ", feeSafe);
        console.log("Owner (Safe): ", owner);
        console.log("Liquidator:   ", opsKey);
        if (opsKey == address(0)) {
            console.log("NOTE: liquidator unset -- ops-key path deploys PAUSED;");
            console.log("      enable later with a Safe tx: setLiquidator(opsKey)");
        }

        if (!confirmed) {
            console.log("");
            console.log("DRY-RUN: OFL_CONFIRM != 1, NOT broadcasting.");
            console.log("Review the resolved args above, then re-run with OFL_CONFIRM=1");
            console.log("(and --broadcast + a signing key) to deploy.");
            return OphisFeeLiquidator(payable(address(0)));
        }

        vm.startBroadcast();
        liquidator = new OphisFeeLiquidator(settlement, feeSafe, owner, opsKey);
        vm.stopBroadcast();

        console.log("Deployed OphisFeeLiquidator at:", address(liquidator));
        console.log("Next steps (owner ceremonies, see fee-treasury-ops-runbook.md):");
        console.log("  1. record the address in contracts/deployments/<network>/ + networks.json");
        console.log("  2. schedule the 24h Timelock addSolver(liquidator) ceremony");
        console.log("  3. after execution, verify authenticator.isSolver(liquidator)");
        console.log("  4. owner Safe: setSweepToken(feeToken, true) per fee denomination");
        console.log("     (sweepTokenAllowed ships EMPTY; non-native sweeps revert until set)");
    }

    /// @dev Settlement resolves from OFL_SETTLEMENT; the mainnet default is
    /// only allowed on chain 10.
    function _resolveSettlement() internal view returns (address) {
        return _resolveMainnetGated("OFL_SETTLEMENT", DEFAULT_SETTLEMENT);
    }

    /// @dev Return the env override if set; otherwise the mainnet default, but
    /// ONLY on chain 10. Off chain 10 with no override is a hard error, so a
    /// Sepolia (or any non-OP) run can never silently inherit a mainnet Safe.
    function _resolveMainnetGated(string memory key, address mainnetDefault) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            require(v != address(0), string.concat("DeployFeeLiquidator: ", key, " is address(0)"));
            return v;
        } catch {
            require(
                block.chainid == OP_MAINNET,
                string.concat("DeployFeeLiquidator: ", key, " required off chain 10 (no mainnet default)")
            );
            return mainnetDefault;
        }
    }

    function _isConfirmed() internal view returns (bool) {
        try vm.envString("OFL_CONFIRM") returns (string memory v) {
            return keccak256(bytes(v)) == keccak256(bytes("1"));
        } catch {
            return false;
        }
    }

    function _hasCode(address a) internal view returns (bool) {
        return a.code.length > 0;
    }
}
