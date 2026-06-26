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

export { GPV2_SETTLEMENT } from '../safe/addresses.js';

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
