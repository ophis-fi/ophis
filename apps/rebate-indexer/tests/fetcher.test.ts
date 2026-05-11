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
});

describe('fetcher.fetchChainTrades', () => {
  const handlers = vi.hoisted(() => ({
    trades: vi.fn(),
    order: vi.fn(),
    blockTime: vi.fn(),
  }));
  const server = setupServer(
    http.get(`${COW_FAKE_BASE}/xdai/api/v1/trades`, () => HttpResponse.json(handlers.trades())),
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
    const rows = await fetchChainTrades(100, { blockTimestampLookup: async () => new Date('2026-05-01T12:00:00Z') });
    expect(rows.map((r) => r.tradeUid)).toEqual([ophisUid]);
    expect(rows[0]!.appCode).toBe('ophis');
  });

  it('paginates until the API returns fewer than limit rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => sampleTrade('0x' + i.toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    const page2 = Array.from({ length: 17 },   (_, i) => sampleTrade('0x' + (1000 + i).toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    let call = 0;
    handlers.trades.mockImplementation(() => (call++ === 0 ? page1 : page2));
    handlers.order.mockImplementation((uid: string) => sampleOrder(uid, '0xa'.padEnd(42, '0'), 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, { blockTimestampLookup: async () => new Date('2026-05-01T12:00:00Z') });
    expect(rows).toHaveLength(1017);
  });
});
