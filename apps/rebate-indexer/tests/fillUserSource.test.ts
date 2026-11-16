import { describe, it, expect, vi } from 'vitest';
import type { PendingDefiLlamaFill } from '../src/fetcher.js';

// The rows upsertDefillamaFills hands to its one INSERT, captured: the in-batch pick, with no database.
const inserted = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/db/index.js', () => ({
  sql: vi.fn(),
  db: { insert: () => ({ values: (rows: unknown[]) => (inserted.push(rows), { onConflictDoUpdate: async () => undefined }) }) },
  schema: { defillamaFills: {} },
}));

const { pickFillUser } = await import('../src/repair/defillamaSettlement.js');
const { upsertDefillamaFills } = await import('../src/fetcher.js');
const FLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec'; // an eth-flow contract: never a usable wallet
const PAYER = `0x${'a1'.repeat(20)}`, STORED = `0x${'b1'.repeat(20)}`, TRADES = `0x${'c1'.repeat(20)}`, OWNER = `0x${'d1'.repeat(20)}`;

describe('pickFillUser: the settlement repair keeps each wallet with its own source', () => {
  it('takes the first usable candidate and its source, skipping an eth-flow contract', () => {
    expect(pickFillUser([[PAYER.toUpperCase().replace('0X', '0x'), 'onchain_user'], [STORED, 'receiver'], [TRADES, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: PAYER, userSource: 'onchain_user' });
    expect(pickFillUser([[null, null], [STORED, 'receiver'], [TRADES, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: STORED, userSource: 'receiver' });
    expect(pickFillUser([[undefined, null], [FLOW, null], [TRADES, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: TRADES, userSource: null });
    expect(pickFillUser([[undefined, null], [null, null], [FLOW, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: OWNER, userSource: 'owner' });
    expect(pickFillUser([[undefined, null], [null, null], [null, null], [FLOW, 'owner']]))
      .toEqual({ userAddress: null, userSource: null });
  });
});

describe('upsertDefillamaFills: the same fill twice in one batch (CodeRabbit, PR #1646)', () => {
  const fill = (userAddress: string, userSource: PendingDefiLlamaFill['userSource'], feeVerified: boolean): PendingDefiLlamaFill => ({
    chainId: 1, blockNumber: 1n, logIndex: 1, tradeUid: `0x${'ee'.repeat(56)}`, transactionHash: `0x${'33'.repeat(32)}`,
    userAddress: userAddress as `0x${string}`, userSource, settlementTimestamp: new Date('2026-11-01T00:00:00Z'),
    sellToken: `0x${'11'.repeat(20)}`, sellAmount: 1n, buyToken: `0x${'22'.repeat(20)}`, buyAmount: 2n, volumeFeeBps: 1, assessedFeeBps: null, feeVerified,
  });
  const kept = async (rows: PendingDefiLlamaFill[]) => {
    inserted.length = 0;
    await upsertDefillamaFills(rows);
    return (inserted[0] as PendingDefiLlamaFill[]).map((r) => [r.userAddress, r.userSource, r.feeVerified]);
  };

  it('of two copies equally verified, keeps the one naming the payer, in either order; a verified copy still wins over a provisional one', async () => {
    const [payer, receiver] = [fill(PAYER, 'onchain_user', true), fill(STORED, 'receiver', true)];
    expect(await kept([receiver, payer])).toEqual([[PAYER, 'onchain_user', true]]);
    expect(await kept([payer, receiver])).toEqual([[PAYER, 'onchain_user', true]]);
    expect(await kept([fill(PAYER, 'onchain_user', false), receiver])).toEqual([[STORED, 'receiver', true]]);
    expect(await kept([payer, fill(STORED, 'onchain_user', false)])).toEqual([[PAYER, 'onchain_user', true]]);
  });
});
