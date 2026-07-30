/**
 * GPv2Settlement ABI fragments the on-chain settle() decoder needs. Verified
 * against the contract source:
 *   - Trade event: contracts/src/contracts/GPv2Settlement.sol:50-58
 *   - settle() fn: contracts/src/contracts/GPv2Settlement.sol:121-126
 *   - GPv2Trade.Data tuple (field order): libraries/GPv2Trade.sol:16-28
 *   - GPv2Interaction.Data tuple: libraries/GPv2Interaction.sol:9-13
 *
 * The interactions param is `(address,uint256,bytes)[][3]` (NOT bytes[][3]); the
 * full, correct signature is required or decodeFunctionData misaligns the calldata.
 */
import { parseAbiItem } from 'viem';
import { GPV2_SETTLEMENT } from '../safe/addresses.js';

export { GPV2_SETTLEMENT } from '../safe/addresses.js';

/**
 * Sovereign Ophis GPv2Settlement deployments. Optimism (10) and Unichain (130) run
 * their OWN settlement contracts (independent CoW-protocol instances), NOT the
 * canonical CREATE2 GPV2_SETTLEMENT that every hosted CoW chain shares. The on-chain
 * decoder must getLogs against THIS address on those chains or it scans the wrong
 * contract and finds zero Ophis trades. Sourced from the live infra config
 * (infra/{optimism,unichain}-mainnet/configs/*.toml `settlement = ...`).
 */
export const SOVEREIGN_SETTLEMENT: Readonly<Record<number, `0x${string}`>> = Object.freeze({
  10: '0x310784c7FCE12d578dA6f53460777bAc9718B859', // Optimism
  130: '0x108A678716e5E1776036eF044CAB7064226F714E', // Unichain
});

/** The GPv2Settlement contract whose Trade events the decoder scans on `chainId`:
 *  the sovereign deployment on OP/Unichain, else the canonical shared address. */
export function settlementAddressFor(chainId: number): `0x${string}` {
  return SOVEREIGN_SETTLEMENT[chainId] ?? GPV2_SETTLEMENT;
}

export const TRADE_EVENT = parseAbiItem(
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
);

export const SETTLE_FN = parseAbiItem(
  'function settle(address[] tokens, uint256[] clearingPrices, ' +
    '(uint256 sellTokenIndex, uint256 buyTokenIndex, address receiver, uint256 sellAmount, ' +
    'uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, uint256 flags, ' +
    'uint256 executedAmount, bytes signature)[] trades, ' +
    '(address target, uint256 value, bytes callData)[][3] interactions)',
);
