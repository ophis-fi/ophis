import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const COW_FAKE_BASE = 'https://api.cow.fi';

const sampleTrade = (uid: string, owner: string, sell = '1000000000000000000', buy = '2500000000') => ({
  blockNumber: 35_000_000,
  logIndex: 1,
  orderUid: uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: sell,
  buyAmount: buy,
  txHash: '0x' + '11'.repeat(32),
});

const sampleOrder = (uid: string, owner: string, appCode = 'ophis') => ({
  uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: '1000000000000000000',
  buyAmount: '2500000000',
  appData: '0xabc',
  fullAppData: JSON.stringify({ appCode, metadata: { partnerFee: { recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' } } }),
  creationDate: '2026-05-01T12:00:00Z',
  status: 'fulfilled',
  executedSellAmount: '1000000000000000000',
  executedBuyAmount: '2500000000',
});

// Hoisted to the top level (vitest 4 warns — and will error in a future version —
// if vi.hoisted() is nested inside describe()). It still executes before imports.
const handlers = vi.hoisted(() => ({
  trades: vi.fn(),
  order: vi.fn(),
  blockTime: vi.fn(),
}));

describe('fetcher.fetchChainTrades', () => {
  const server = setupServer(
    http.get(`${COW_FAKE_BASE}/xdai/api/v2/trades`, () => HttpResponse.json(handlers.trades())),
    http.get(`${COW_FAKE_BASE}/xdai/api/v1/orders/:uid`, ({ params }) =>
      HttpResponse.json(handlers.order(params.uid))),
  );
  beforeEach(() => {
    process.env.COW_API_BASE = COW_FAKE_BASE;
    server.listen();
  });
  afterEach(() => {
    server.resetHandlers();
    server.close();
  });

  it('skips trades whose order has appCode != ophis/greg', async () => {
    const ophisUid = '0x' + '0a'.repeat(56);
    const otherUid = '0x' + '0b'.repeat(56);
    handlers.trades.mockReturnValue([sampleTrade(ophisUid, '0xa'.padEnd(42, '0')), sampleTrade(otherUid, '0xb'.padEnd(42, '0'))]);
    handlers.order.mockImplementation((uid: string) => uid === ophisUid
      ? sampleOrder(ophisUid, '0xa'.padEnd(42, '0'), 'ophis')
      : sampleOrder(otherUid, '0xb'.padEnd(42, '0'), 'someoneelse'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, '0xa'.padEnd(42, '0') as `0x${string}`, {});
    expect(rows.map((r) => r.tradeUid)).toEqual([ophisUid]);
    expect(rows[0]!.appCode).toBe('ophis');
    // block_timestamp now comes from the order's creationDate.
    expect(rows[0]!.blockTimestamp.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  it('paginates until the API returns fewer than limit rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => sampleTrade('0x' + i.toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    const page2 = Array.from({ length: 17 },   (_, i) => sampleTrade('0x' + (1000 + i).toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    let call = 0;
    handlers.trades.mockImplementation(() => (call++ === 0 ? page1 : page2));
    handlers.order.mockImplementation((uid: string) => sampleOrder(uid, '0xa'.padEnd(42, '0'), 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, '0xa'.padEnd(42, '0') as `0x${string}`, {});
    expect(rows).toHaveLength(1017);
  });

  it('records terminal orders (fulfilled/cancelled/expired) with executed amounts, skips active ones', async () => {
    const fulfilledUid = '0x' + '0e'.repeat(56);
    const cancelledUid = '0x' + '0f'.repeat(56);
    const openUid = '0x' + '1a'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([
      sampleTrade(fulfilledUid, owner, '1'), // fill amount '1' differs from executed total
      sampleTrade(cancelledUid, owner, '1'),
      sampleTrade(openUid, owner, '1'),
    ]);
    handlers.order.mockImplementation((uid: string) => {
      const base = sampleOrder(uid, owner, 'ophis');
      if (uid === fulfilledUid) return { ...base, status: 'fulfilled', executedSellAmount: '9999', executedBuyAmount: '8888' };
      if (uid === cancelledUid) return { ...base, status: 'cancelled', executedSellAmount: '500', executedBuyAmount: '400' }; // partial fill, then cancelled
      return { ...base, status: 'open' }; // still active
    });

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    const byUid = Object.fromEntries(rows.map((r) => [r.tradeUid, r]));
    expect(Object.keys(byUid).sort()).toEqual([cancelledUid, fulfilledUid].sort()); // 'open' skipped
    expect(byUid[fulfilledUid]!.sellAmount).toBe(9999n); // executed total, not the fill's '1'
    expect(byUid[fulfilledUid]!.buyAmount).toBe(8888n);
    expect(byUid[cancelledUid]!.sellAmount).toBe(500n); // partial settled volume of a cancelled order is counted
  });

  it('extracts + clamps appData partnerFee.volumeBps per trade (5/10/1, inflated->retail, absent->null, array shape)', async () => {
    const owner = '0xa'.padEnd(42, '0');
    const REC = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
    const mk = (n: number): string => '0x' + n.toString(16).padStart(112, '0');
    const ATTACKER = '0x' + 'de'.repeat(20);
    const uids = {
      sdk: mk(0x51), retail: mk(0x52), stable: mk(0x53),
      inflated: mk(0x54), absent: mk(0x55), arr: mk(0x56), zero: mk(0x57),
      decoy: mk(0x58), wrongRecipient: mk(0x59),
      legacyBps: mk(0x5a), surplusNotVolume: mk(0x5b), piNotVolume: mk(0x5c),
    };
    handlers.trades.mockReturnValue(Object.values(uids).map((u) => sampleTrade(u, owner)));
    const withFee = (uid: string, pf: unknown) => ({
      ...sampleOrder(uid, owner, 'ophis'),
      fullAppData: JSON.stringify({ appCode: 'ophis', metadata: { partnerFee: pf } }),
    });
    handlers.order.mockImplementation((uid: string) => {
      switch (uid) {
        case uids.sdk: return withFee(uid, { volumeBps: 5, recipient: REC });
        case uids.retail: return withFee(uid, { volumeBps: 10, recipient: REC });
        case uids.stable: return withFee(uid, { volumeBps: 1, recipient: REC });
        case uids.inflated: return withFee(uid, { volumeBps: 50, recipient: REC }); // crafted -> clamp to 10
        case uids.absent: return withFee(uid, { recipient: REC }); // no volumeBps -> null (retail default at accrual)
        case uids.arr: return withFee(uid, [{ volumeBps: 5, recipient: REC }]); // array partnerFee shape
        case uids.zero: return withFee(uid, { volumeBps: 0, recipient: REC }); // <1 -> null
        // DECOY: attacker entry first (higher bps), real Ophis entry second. Must
        // ignore the decoy and use the Ophis-recipient rate (5).
        case uids.decoy: return withFee(uid, [{ volumeBps: 10, recipient: ATTACKER }, { volumeBps: 5, recipient: REC }]);
        // Fee paid to a non-Ophis recipient only -> not our fee -> null (retail default).
        case uids.wrongRecipient: return withFee(uid, { volumeBps: 5, recipient: ATTACKER });
        // Legacy Volume shape { bps } (no volumeBps) -> backend maps to Volume -> read it.
        case uids.legacyBps: return withFee(uid, { bps: 5, recipient: REC });
        // A surplus / price-improvement policy is NOT a volume fee: the bare bps
        // fallback is suppressed -> null (retail default).
        case uids.surplusNotVolume: return withFee(uid, { surplusBps: 10, maxVolumeBps: 50, bps: 99, recipient: REC });
        case uids.piNotVolume: return withFee(uid, { priceImprovementBps: 25, maxVolumeBps: 50, bps: 99, recipient: REC });
        default: return sampleOrder(uid, owner, 'ophis');
      }
    });

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    const byUid = Object.fromEntries(rows.map((r) => [r.tradeUid, r.volumeFeeBps]));
    expect(byUid[uids.sdk]).toBe(5);
    expect(byUid[uids.retail]).toBe(10);
    expect(byUid[uids.stable]).toBe(1);
    expect(byUid[uids.inflated]).toBe(10); // clamped to the retail ceiling: can't inflate the rebate base
    expect(byUid[uids.absent]).toBeNull();
    expect(byUid[uids.arr]).toBe(5);
    expect(byUid[uids.zero]).toBeNull();
    expect(byUid[uids.decoy]).toBe(5); // decoy entry ignored; only the Ophis-recipient fee counts
    expect(byUid[uids.wrongRecipient]).toBeNull(); // fee not to Ophis -> not counted
    expect(byUid[uids.legacyBps]).toBe(5); // legacy { bps } Volume shape read
    expect(byUid[uids.surplusNotVolume]).toBeNull(); // surplus policy: bps fallback suppressed
    expect(byUid[uids.piNotVolume]).toBeNull(); // price-improvement policy: bps fallback suppressed
  });
});
