import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';

// Real Ophis (non-canonical) settlement addresses per chain; relayers are
// distinct valid stubs (their real values are covered by @ophis/sdk's own tests
// + the M2 fork integration test). Stubbing @ophis/sdk avoids vitest choking on
// the transitive @cowprotocol/contracts source (the repo convention, see
// packages/agent-swap/tests/swap.test.ts).
const OP_SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859';
const UNI_SETTLEMENT = '0x108A678716e5E1776036eF044CAB7064226F714E';
const OP_RELAYER = '0x8383838383838383838383838383838383838383';
const UNI_RELAYER = '0xabababababababababababababababababababab';

vi.mock('@ophis/sdk', () => ({
  ophisOrderReceiver: (owner: string) => owner,
  assertReceiverIsOwner: (owner: string, receiver: string) => {
    if (owner.toLowerCase() !== receiver.toLowerCase()) throw new Error('receiver != owner');
  },
  getOphisSettlementAddress: (chainId: number) => {
    const m: Record<number, string> = { 10: OP_SETTLEMENT, 130: UNI_SETTLEMENT };
    if (!m[chainId]) throw new Error(`no settlement for ${chainId}`);
    return m[chainId];
  },
  getOphisVaultRelayer: (chainId: number) => {
    const m: Record<number, string> = { 10: OP_RELAYER, 130: UNI_RELAYER };
    if (!m[chainId]) throw new Error(`no relayer for ${chainId}`);
    return m[chainId];
  },
  getOphisOrderDomain: (chainId: number) => ({
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId,
    verifyingContract: chainId === 130 ? UNI_SETTLEMENT : OP_SETTLEMENT,
  }),
}));

const { assembleVaultOrder, buildPresignTxBatch, computeOrderUid, assertUidMatches, ORDER_TTL_SECONDS } = await import('../src/order.js');

const SAFE = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const SELL = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const BUY = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const APP_DATA_HASH = ('0x' + '0'.repeat(64)) as `0x${string}`;
const CANONICAL_COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';
const MAX_UINT256 = 2n ** 256n - 1n;

const APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
const decodeApprove = (data: `0x${string}`) =>
  decodeFunctionData({ abi: APPROVE_ABI, data }) as unknown as { functionName: string; args: [string, bigint] };

const baseQuote = {
  safe: SAFE,
  quoteSellToken: SELL,
  quoteBuyToken: BUY,
  quoteSellAmount: '999000',
  quoteFeeAmount: '1000', // gross = 1_000_000
  quoteBuyAmount: '2000000',
  requestedSellToken: SELL,
  requestedBuyToken: BUY,
  requestedGross: 1_000_000n,
  appDataHash: APP_DATA_HASH,
  slippageBps: 50,
  ttlSeconds: ORDER_TTL_SECONDS,
  nowSeconds: 1_000_000_000,
};

describe('assembleVaultOrder', () => {
  it('produces a hardened order on the happy path', () => {
    const o = assembleVaultOrder(baseQuote);
    expect(o.feeAmount).toBe('0'); // invariant 1
    expect(o.receiver.toLowerCase()).toBe(SAFE); // invariant 2
    expect(o.sellAmount).toBe('1000000'); // gross = net + fee
    expect(o.buyAmount).toBe('1990000'); // 2_000_000 * 9950/10000
    expect(o.validTo).toBe(1_000_000_000 + ORDER_TTL_SECONDS); // invariant 9
    expect(o.partiallyFillable).toBe(false);
  });
  it('rejects a substituted sell token', () => {
    expect(() => assembleVaultOrder({ ...baseQuote, quoteSellToken: BUY })).toThrow(/sellToken.*refusing to sign/i);
  });
  it('rejects a gross drift / over-pull', () => {
    expect(() => assembleVaultOrder({ ...baseQuote, quoteFeeAmount: '2000' })).toThrow(/gross.*refusing to sign/i);
  });
  it('rejects a zero-proceeds buy floor', () => {
    expect(() => assembleVaultOrder({ ...baseQuote, quoteBuyAmount: '1' })).toThrow(/zero-proceeds/i);
  });
  it('rejects slippage above the cap', () => {
    expect(() => assembleVaultOrder({ ...baseQuote, slippageBps: 5001 })).toThrow(/out of range/i);
  });
  it('accepts when the signed floor meets the caller minBuyAmount', () => {
    expect(() => assembleVaultOrder({ ...baseQuote, minBuyAmount: 1_500_000n })).not.toThrow();
  });
  it('rejects when the quote is below the caller minBuyAmount', () => {
    expect(() => assembleVaultOrder({ ...baseQuote, minBuyAmount: 2_000_000n })).toThrow(/below the caller|minimum out/i);
  });
  it("rejects Codex's hostile tiny buyAmount when a minBuyAmount is set", () => {
    // quote buyAmount 2 -> slipped floor 1; with a real min-out this is refused
    expect(() => assembleVaultOrder({ ...baseQuote, quoteBuyAmount: '2', minBuyAmount: 1_000_000n })).toThrow(/below the caller|zero-proceeds/i);
  });
});

describe('buildPresignTxBatch', () => {
  const CHAIN = 10;
  const ORDER_UID = ('0x' + '12'.repeat(56)) as `0x${string}`;

  it('targets the OPHIS settlement, never canonical CoW', () => {
    const { txs, settlement } = buildPresignTxBatch({ chainId: CHAIN, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1_000_000n, currentAllowance: 1_000_000n });
    const presign = txs[txs.length - 1]!;
    expect(presign.to.toLowerCase()).toBe(OP_SETTLEMENT.toLowerCase());
    expect(settlement.toLowerCase()).not.toBe(CANONICAL_COW_SETTLEMENT); // invariant 4
  });

  it('unknown allowance -> reset-to-0 + exact approve + presign', () => {
    const { txs } = buildPresignTxBatch({ chainId: CHAIN, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1_000_000n, currentAllowance: null });
    expect(txs).toHaveLength(3);
    const a0 = decodeApprove(txs[0]!.data);
    const a1 = decodeApprove(txs[1]!.data);
    expect(txs[0]!.to).toBe(SELL);
    expect(a0.args[0].toLowerCase()).toBe(OP_RELAYER.toLowerCase()); // spender == Ophis relayer
    expect(a0.args[1]).toBe(0n); // reset
    expect(a1.args[1]).toBe(1_000_000n); // EXACT (invariant 5)
    expect(a1.args[1]).not.toBe(MAX_UINT256);
  });

  it('zero allowance -> exact approve (no reset) + presign', () => {
    const { txs } = buildPresignTxBatch({ chainId: CHAIN, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1_000_000n, currentAllowance: 0n });
    expect(txs).toHaveLength(2);
    expect(decodeApprove(txs[0]!.data).args[1]).toBe(1_000_000n);
  });

  it('insufficient non-zero allowance -> reset + exact approve + presign', () => {
    const { txs } = buildPresignTxBatch({ chainId: CHAIN, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1_000_000n, currentAllowance: 500_000n });
    expect(txs).toHaveLength(3);
    expect(decodeApprove(txs[0]!.data).args[1]).toBe(0n);
    expect(decodeApprove(txs[1]!.data).args[1]).toBe(1_000_000n);
  });

  it('sufficient allowance -> presign only (no approve)', () => {
    const { txs } = buildPresignTxBatch({ chainId: CHAIN, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1_000_000n, currentAllowance: 1_000_000n });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.to.toLowerCase()).toBe(OP_SETTLEMENT.toLowerCase());
  });

  it('resolves distinct Ophis settlement per chain (OP vs Unichain)', () => {
    const op = buildPresignTxBatch({ chainId: 10, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1n, currentAllowance: 1n });
    const uni = buildPresignTxBatch({ chainId: 130, orderUid: ORDER_UID, sellToken: SELL, pullAmount: 1n, currentAllowance: 1n });
    expect(op.settlement.toLowerCase()).toBe(OP_SETTLEMENT.toLowerCase());
    expect(uni.settlement.toLowerCase()).toBe(UNI_SETTLEMENT.toLowerCase());
    expect(op.settlement.toLowerCase()).not.toBe(uni.settlement.toLowerCase());
  });
});

describe('computeOrderUid + assertUidMatches', () => {
  // Golden vector: the uid for assembleVaultOrder(baseQuote) on OP, cross-checked
  // against ethers v6 TypedDataEncoder (independent EIP-712 impl) so the digest +
  // 56-byte packing (digest ++ owner ++ validTo:uint32BE) are locked in.
  const GOLDEN_UID =
    '0x1e4a566ea52b5671d8ff0b5a5a589772c1a0b659e6838b41ce07249768dcf3d133333333333333333333333333333333333333333b9ad108';
  const order = assembleVaultOrder(baseQuote);

  it('matches the ethers-cross-checked golden uid', () => {
    expect(computeOrderUid(order, 10, SAFE).toLowerCase()).toBe(GOLDEN_UID);
  });
  it('is deterministic and exactly 56 bytes', () => {
    const uid = computeOrderUid(order, 10, SAFE);
    expect(uid).toBe(computeOrderUid(order, 10, SAFE));
    expect((uid.length - 2) / 2).toBe(56);
  });
  it('changes when the order changes', () => {
    const other = assembleVaultOrder({ ...baseQuote, quoteBuyAmount: '3000000' });
    expect(computeOrderUid(other, 10, SAFE)).not.toBe(computeOrderUid(order, 10, SAFE));
  });
  it('assertUidMatches returns the computed uid when the host agrees', () => {
    const uid = computeOrderUid(order, 10, SAFE);
    expect(assertUidMatches(uid, order, 10, SAFE)).toBe(uid);
  });
  it('assertUidMatches THROWS when the host returns a different uid (drain-redirect defense)', () => {
    const evil = ('0x' + 'ff'.repeat(56)) as `0x${string}`;
    expect(() => assertUidMatches(evil, order, 10, SAFE)).toThrow(/does not match|refusing to presign/i);
  });
  it('assertUidMatches throws on a non-string uid', () => {
    expect(() => assertUidMatches(undefined as never, order, 10, SAFE)).toThrow();
  });
});
