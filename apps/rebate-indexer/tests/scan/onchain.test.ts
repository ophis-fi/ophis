// tests/scan/onchain.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillsFromLogs, classifyFills, type DecodedTradeLog } from '../../src/scan/sources/onchain.js';
import { collectTradeLogs, type LogClient } from '../../src/scan/sources/onchain.js';
import { CowOrder } from '../../src/cow/types.js';

describe('CowOrder schema', () => {
  it('retains receiver through a zod parse (eth-flow attribution depends on it)', () => {
    const parsed = CowOrder.parse({
      uid: '0xuid', owner: '0xrouter', sellToken: '0xc02a', buyToken: '0xdac1',
      sellAmount: '1', buyAmount: '1', appData: '0xhash',
      receiver: '0x0494f503912c101bfd76b88e4f5d8a33de284d1a', creationDate: '2026-06-18T20:43:11Z',
    });
    expect(parsed.receiver).toBe('0x0494f503912c101bfd76b88e4f5d8a33de284d1a');
  });
});

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

const log = (orderUid: string, over: Partial<DecodedTradeLog['args']> = {}): DecodedTradeLog => ({
  args: {
    owner: '0xba3cb449bd2b4adddbc894d8697f5170800eadec',
    sellToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    buyToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    sellAmount: 41000000000000000n,
    buyAmount: 69927413n,
    orderUid: orderUid as `0x${string}`,
    ...over,
  },
  transactionHash: '0x5348',
  blockNumber: 100n,
});

describe('fillsFromLogs', () => {
  it('aggregates (sums) multiple in-window fills of the same order', () => {
    const fills = fillsFromLogs([log('0xuid1'), log('0xuid1'), log('0xuid2')]);
    expect(fills.map((f) => f.orderUid)).toEqual(['0xuid1', '0xuid2']);
    expect(fills[0]!.sellAmount).toBe(82000000000000000n); // 2 x 41e15 summed
    expect(fills[0]!.buyAmount).toBe(139854826n); // 2 x 69927413 summed
  });
});

describe('classifyFills', () => {
  const ophisOrder: CowOrder = {
    uid: '0xuid1', owner: '0xba3c', sellToken: '0xc02a', buyToken: '0xdac1',
    sellAmount: '41000000000000000', buyAmount: '69927413',
    appData: '0xhash', fullAppData: fx('mainnet-ophis-order.json'),
    creationDate: '2026-06-18T20:43:11Z', status: 'fulfilled',
    receiver: '0x0494f503912c101bfd76b88e4f5d8a33de284d1a',
  } as unknown as CowOrder; // short hex is fine for this unit test: only appCode/receiver/creationDate matter to classifyFills
  const nonOphis: CowOrder = { ...ophisOrder, uid: '0xuid2', fullAppData: fx('non-ophis-order.json') };

  const t0 = Math.floor(new Date('2026-06-17T00:00:00Z').getTime() / 1000);
  // Every fixture log settles in block 100; we resolve that block to an in-window
  // timestamp (later than t0) unless a test overrides the resolver.
  const settledInWindow = t0 + 3600;
  const okBlockTs = async (_b: bigint) => settledInWindow;

  it('keeps Ophis orders, drops non-Ophis, counts coverage', async () => {
    const cache = new Map<string, any>();
    const deps = {
      getOrder: async (_c: number, uid: `0x${string}`) => (uid === '0xuid1' ? ophisOrder : nonOphis),
      cache: { get: (u: string) => cache.get(u), set: (u: string, v: any) => cache.set(u, v), save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1'), log('0xuid2')]), t0, deps);
    expect(out.ophisFound).toBe(1);
    expect(out.swaps).toHaveLength(1);
    expect(out.swaps[0]!.orderUid).toBe('0xuid1'); // the non-Ophis 0xuid2 is excluded
    expect(out.swaps[0]!.appCode).toBe('ophis');
    expect(out.swaps[0]!.feeBps).toBe(10);
    expect(out.swaps[0]!.receiver).toBe('0x0494f503912c101bfd76b88e4f5d8a33de284d1a');
    // tsUtc is the SETTLEMENT block time, not the order creationDate
    expect(out.swaps[0]!.tsUtc).toBe(new Date(settledInWindow * 1000).toISOString());
    // negative-cached the non-Ophis uid (its appData is a parseable object)
    expect(cache.get('0xuid2')).toBe('none');
  });

  it('recognises a capitalised "Ophis" appCode (case-insensitive)', async () => {
    const capOrder = { ...ophisOrder, fullAppData: '{"appCode":"Ophis","metadata":{"partnerFee":{"volumeBps":10}}}' };
    const deps = {
      getOrder: async () => capOrder,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.ophisFound).toBe(1);
    expect(out.swaps[0]!.appCode).toBe('ophis'); // canonicalised to lower-case
  });

  it('reports the SUM of in-window fills, NOT the order lifetime executed total (TWAP straddle)', async () => {
    // A TWAP order whose lifetime executedSellAmount (123e15) is larger than its
    // in-window settlement: only TWO fills are in the fetched (window-bounded) logs.
    // We must report the sum of those in-window fills (2 x 41e15), not the lifetime
    // total, or an order that started filling before t0 over-pays.
    const twapOrder = { ...ophisOrder, executedSellAmount: '123000000000000000', executedBuyAmount: '209782239' };
    const deps = {
      getOrder: async () => twapOrder,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1'), log('0xuid1')]), t0, deps);
    expect(out.swaps[0]!.sell.amount).toBe('82000000000000000'); // 2 in-window fills summed
    expect(out.swaps[0]!.buy.amount).toBe('139854826');
  });

  it('reports a single in-window fill amount as-is', async () => {
    const deps = {
      getOrder: async () => ophisOrder,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.swaps[0]!.sell.amount).toBe('41000000000000000');
    expect(out.swaps[0]!.buy.amount).toBe('69927413');
  });

  it('window-filters by SETTLEMENT block time (not creationDate)', async () => {
    // Order created at 2026-06-18 (well after t0) but its settlement block resolves
    // BEFORE t0 -> dropped. (creationDate would have kept it; settlement time drops it.)
    const deps = {
      getOrder: async () => ophisOrder,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
      getBlockTimestamp: async () => t0 - 1,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.swaps).toHaveLength(0);
  });

  it('counts (does NOT negative-cache) an order created before t0 but settled in-window', async () => {
    // A limit order created long ago but settled now must be COUNTED. creationDate
    // is before t0; settlement time is in-window.
    const oldCreation = { ...ophisOrder, creationDate: '2025-01-01T00:00:00Z' };
    const deps = {
      getOrder: async () => oldCreation,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.ophisFound).toBe(1);
  });

  it('does NOT negative-cache an order whose fullAppData is unresolved (null)', async () => {
    const cache = new Map<string, any>();
    const deps = {
      getOrder: async () => ({ ...ophisOrder, fullAppData: null }),
      cache: { get: (u: string) => cache.get(u), set: (u: string, v: any) => cache.set(u, v), save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.unresolved).toBe(1);          // retried next scan, not silently dropped
    expect(out.swaps).toHaveLength(0);
    expect(cache.get('0xuid1')).toBeUndefined(); // NOT poisoned
  });

  it('does NOT negative-cache an order whose fullAppData is unparsable', async () => {
    const cache = new Map<string, any>();
    const deps = {
      getOrder: async () => ({ ...ophisOrder, fullAppData: '{not json' }),
      cache: { get: (u: string) => cache.get(u), set: (u: string, v: any) => cache.set(u, v), save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.unresolved).toBe(1);
    expect(cache.get('0xuid1')).toBeUndefined();
  });

  it('counts a fill as unresolved when getOrder throws', async () => {
    const deps = {
      getOrder: async () => { throw new Error('order aged out of CoW DB'); },
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
      getBlockTimestamp: okBlockTs,
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), t0, deps);
    expect(out.unresolved).toBe(1);
    expect(out.swaps).toHaveLength(0);
    expect(out.ophisFound).toBe(0);
  });
});

describe('collectTradeLogs', () => {
  it('chunks the block range and concatenates', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const client = {
      getBlockNumber: async () => 0n,
      getBlock: async () => ({ timestamp: 0n }),
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return [];
      },
    } as unknown as LogClient;
    await collectTradeLogs(client, 0n, 4500n, 2000n);
    expect(calls).toEqual([[0n, 1999n], [2000n, 3999n], [4000n, 4500n]]);
  });

  it('halves the chunk and retries on a getLogs error, then completes', async () => {
    let attempts = 0;
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async () => ({ timestamp: 0n }),
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        attempts += 1;
        if (toBlock - fromBlock > 500n) throw new Error('query returned more than 10000 results');
        return [];
      },
    } as unknown as LogClient;
    // chunk 2000 over [0,1000]: fail[0,1999] -> fail[0,999] -> ok[0,499] -> ok[500,1000] = 4 attempts.
    const result = await collectTradeLogs(client, 0n, 1000n, 2000n);
    expect(attempts).toBeGreaterThanOrEqual(3); // backed off below the 500-span limit before succeeding
    expect(result).toBeInstanceOf(Array);       // terminated successfully (did not throw)
  });
});
