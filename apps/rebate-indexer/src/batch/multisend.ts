import { encodeFunctionData, parseAbi, pad, toHex, concatHex, sliceHex, type Hex } from 'viem';

const ERC20_TRANSFER = parseAbi(['function transfer(address to, uint256 amount)']);

export interface Transfer {
  readonly to: `0x${string}`;
  readonly amount: bigint;
}

export interface InnerCall {
  readonly to: `0x${string}`;
  readonly value: bigint;
  readonly data: `0x${string}`;
}

/** Produce the ERC20.transfer calldata for each rebate transfer, all targeting WETH on the payout chain. */
export function encodeWethTransfers(transfers: readonly Transfer[], weth: `0x${string}`): InnerCall[] {
  return transfers.map((t) => ({
    to: weth,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: 'transfer', args: [t.to, t.amount] }),
  }));
}

/**
 * Pack inner calls into the Safe MultiSendCallOnly transactions byte string.
 *
 * Per Safe MultiSend ABI:
 *   for each call: 1 byte op (0 = CALL) || 20 bytes to || 32 bytes value || 32 bytes dataLen || dataLen bytes data
 *
 * The whole thing is concatenated into a single bytes argument passed to multiSend(bytes).
 */
export function encodeMultiSend(inner: readonly InnerCall[]): Hex {
  if (inner.length === 0) throw new Error('encodeMultiSend: at least one inner call required');
  const frames: Hex[] = inner.map((c) => {
    const dataLen = (c.data.length - 2) / 2;                           // bytes
    return concatHex([
      '0x00',                                                          // operation = CALL (CallOnly variant rejects anything else)
      c.to,
      pad(toHex(c.value), { size: 32 }),
      pad(toHex(BigInt(dataLen)), { size: 32 }),
      c.data,
    ]);
  });
  return concatHex(frames).toLowerCase() as Hex;
}

/**
 * Build the outer `multiSend(bytes)` calldata. This is the calldata the Safe will
 * DELEGATECALL into the MultiSendCallOnly contract.
 */
export function encodeMultiSendCalldata(transactions: Hex): Hex {
  const abi = parseAbi(['function multiSend(bytes transactions)']);
  return encodeFunctionData({ abi, functionName: 'multiSend', args: [transactions] });
}

/** Helper: full pipeline for a list of (recipient, amount) WETH rebates → outer multiSend calldata. */
export function buildRebateMultisend(transfers: readonly Transfer[], weth: `0x${string}`): Hex {
  return encodeMultiSendCalldata(encodeMultiSend(encodeWethTransfers(transfers, weth)));
}

export { sliceHex };                                                   // re-export so tests can decode for debugging
