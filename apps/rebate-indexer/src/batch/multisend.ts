import {
  encodeFunctionData,
  decodeFunctionData,
  parseAbi,
  pad,
  toHex,
  concatHex,
  sliceHex,
  hexToBigInt,
  size,
  type Hex,
} from 'viem';

const ERC20_TRANSFER = parseAbi(['function transfer(address to, uint256 amount)']);
const MULTISEND_ABI = parseAbi(['function multiSend(bytes transactions)']);

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

/**
 * Inverse of `encodeMultiSend`+`encodeMultiSendCalldata`: decode an outer
 * `multiSend(bytes)` calldata back into its inner calls. Returns `[]` if `calldata`
 * is not a `multiSend` (e.g. a plain owner-queued tx) or is malformed — it NEVER
 * throws, so it is safe to run over arbitrary pending Safe txs. Used to inspect the
 * Safe queue for an already-pending VaultRelayer approval before re-queuing one
 * (fee-conversion idempotency, #360). The `operation` byte is parsed and discarded
 * (callers only need to/value/data).
 */
export function decodeMultiSendCalldata(calldata: Hex): InnerCall[] {
  let packed: Hex;
  try {
    const decoded = decodeFunctionData({ abi: MULTISEND_ABI, data: calldata });
    if (decoded.functionName !== 'multiSend') return [];
    packed = decoded.args[0] as Hex;
  } catch {
    return []; // not a multiSend / undecodable — treat as "no inner calls"
  }
  const calls: InnerCall[] = [];
  try {
    const total = size(packed); // bytes
    let off = 0;
    // Each frame: op(1) || to(20) || value(32) || dataLen(32) || data(dataLen).
    // The fixed header is 85 bytes; stop on any truncated/garbage tail rather than throw.
    while (off + 85 <= total) {
      const to = sliceHex(packed, off + 1, off + 21) as `0x${string}`;
      const value = hexToBigInt(sliceHex(packed, off + 21, off + 53));
      // dataLen is an untrusted 32-byte field: parse as bigint and bounds-check BEFORE
      // any Number() conversion, so a maliciously huge length (up to 2^256-1) can't
      // throw IntegerOutOfRangeError. If it overruns the buffer, the frame is malformed.
      const dataLen = hexToBigInt(sliceHex(packed, off + 53, off + 85));
      const dataEnd = BigInt(off + 85) + dataLen;
      if (dataEnd > BigInt(total)) break; // declared length overruns the buffer — malformed
      const end = Number(dataEnd); // safe: dataEnd <= total, a real byte length
      const data = (dataLen === 0n ? '0x' : sliceHex(packed, off + 85, end)) as `0x${string}`;
      calls.push({ to, value, data });
      off = end;
    }
  } catch {
    // Defense-in-depth: any unexpected parse error on malformed packed bytes returns
    // the frames parsed so far rather than throwing — this runs over untrusted pending
    // Safe-queue data, and a partial/empty read only weakens the best-effort
    // idempotency filter (the on-chain allowance check still bounds re-queuing).
  }
  return calls;
}

