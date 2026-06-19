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
  it('dedups multiple fills of the same order', () => {
    const fills = fillsFromLogs([log('0xuid1'), log('0xuid1'), log('0xuid2')]);
    expect(fills.map((f) => f.orderUid)).toEqual(['0xuid1', '0xuid2']);
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

  it('keeps Ophis orders, drops non-Ophis, counts coverage', async () => {
    const cache = new Map<string, any>();
    const deps = {
      getOrder: async (_c: number, uid: `0x${string}`) => (uid === '0xuid1' ? ophisOrder : nonOphis),
      cache: { get: (u: string) => cache.get(u), set: (u: string, v: any) => cache.set(u, v), save: async () => {} },
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1'), log('0xuid2')]), t0, deps);
    expect(out.ophisFound).toBe(1);
    expect(out.swaps).toHaveLength(1);
    expect(out.swaps[0]!.orderUid).toBe('0xuid1'); // the non-Ophis 0xuid2 is excluded
    expect(out.swaps[0]!.appCode).toBe('ophis');
    expect(out.swaps[0]!.feeBps).toBe(10);
    expect(out.swaps[0]!.receiver).toBe('0x0494f503912c101bfd76b88e4f5d8a33de284d1a');
    // negative-cached the non-Ophis uid
    expect(cache.get('0xuid2')).toBe('none');
  });

  it('window-filters by creationDate', async () => {
    const future = Math.floor(new Date('2026-06-19T00:00:00Z').getTime() / 1000);
    const deps = {
      getOrder: async () => ophisOrder,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), future, deps);
    expect(out.swaps).toHaveLength(0); // order is older than t0
  });

  it('counts a fill as unresolved when getOrder throws', async () => {
    const deps = {
      getOrder: async () => { throw new Error('order aged out of CoW DB'); },
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
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
