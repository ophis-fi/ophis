import { signature, type Address, type Signature } from '@solana/kit';
import { atoms, key, record, request, uid } from './api.js';

export interface OphisSolanaTrade {
  orderUid: string;
  owner: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  protocolFee: string | null;
  feeMint: Address | null;
  txSignature: Signature;
  instructionIndex: number;
  slot?: number;
}

export async function fetchOphisSolanaTrades(
  baseUrl: string,
  owner: Address,
  offset = 0,
  limit = 25,
): Promise<OphisSolanaTrade[]> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw Error('Invalid trade history page');
  const query = new URLSearchParams({
    owner: key(owner),
    offset: String(offset),
    limit: String(limit),
  });
  const rows = await request(baseUrl, 'api/v2/trades?' + query);
  if (!Array.isArray(rows) || rows.length > limit) throw Error('Invalid trade history page');
  return rows.map((row) => {
    const v = record(row);
    const fee = v.protocolFee == null ? null : atoms(v.protocolFee);
    const sellToken = key(v.sellToken),
      buyToken = key(v.buyToken);
    const feeMint = v.feeMint == null ? null : key(v.feeMint);
    if (
      key(v.owner) !== owner ||
      typeof v.txSignature !== 'string' ||
      !Number.isSafeInteger(v.instructionIndex) ||
      typeof v.instructionIndex !== 'number' ||
      v.instructionIndex < 0 ||
      (fee === null) !== (feeMint === null) ||
      (feeMint && feeMint !== sellToken && feeMint !== buyToken)
    )
      throw Error('Invalid trade attribution');
    return {
      owner,
      orderUid: uid(v.orderUid),
      sellToken,
      buyToken,
      sellAmount: atoms(v.sellAmount),
      buyAmount: atoms(v.buyAmount),
      protocolFee: fee,
      feeMint,
      txSignature: signature(v.txSignature),
      instructionIndex: v.instructionIndex,
      ...(typeof v.slot === 'number' && Number.isSafeInteger(v.slot) && v.slot >= 0 ? { slot: v.slot } : {}),
    };
  });
}
