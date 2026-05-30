import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../src/db/migrate.js';
import { runScorer } from '../src/scorer.js';

const COW = 'https://api.cow.fi';

const trade = (uid: string, owner: string, sellAmount = '1000000000000000000') => ({
  blockNumber: 35_000_000,
  logIndex: 1,
  orderUid: uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount,
  buyAmount: '2500000000',
  txHash: '0x' + '11'.repeat(32),
});

let pg: StartedPostgreSqlContainer;
const handlers = {
  trades: [] as any[],
  order: (uid: string) => ({
    uid,
    owner: '0x' + 'a'.repeat(40),
    sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
    buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    sellAmount: '1000000000000000000',
    buyAmount:  '2500000000',
    appData: '0xabc',
    fullAppData: JSON.stringify({ appCode: 'ophis' }),
    creationDate: '2026-05-01T12:00:00Z',
    status: 'fulfilled',
    executedSellAmount: '1000000000000000000',
    executedBuyAmount: '2500000000',
  }),
};
const server = setupServer(
  // xdai (chainId=100) — the chain under test
  http.get(`${COW}/xdai/api/v1/trades`, () => HttpResponse.json(handlers.trades)),
  http.get(`${COW}/xdai/api/v1/orders/:uid`, ({ params }) => HttpResponse.json(handlers.order(params.uid as string))),
  http.post(`${COW}/xdai/api/v1/quote`, async () => HttpResponse.json({
    quote: {
      sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
      buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      sellAmount: '1000000000000000000',
      buyAmount:  '2500000000',                                        // 1 WETH = 2500 USDC
    },
    expiration: '2026-05-01T13:00:00Z',
  })),
  // Catch-all: return empty trades for all other chains so the fetcher doesn't hit real network.
  http.get(`${COW}/:chain/api/v1/trades`, () => HttpResponse.json([])),
);

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.COW_API_BASE = COW;
  server.listen();
  await runMigrations();
}, 60_000);

afterAll(async () => {
  server.close();
  await pg.stop();
});

beforeEach(async () => {
  handlers.trades = [];
});

describe('full nightly cycle', () => {
  it('fetch → price → score → tier yields expected wallet rows', async () => {
    handlers.trades = [
      trade('0x' + '0a'.repeat(56), '0x' + 'a'.repeat(40)),
      trade('0x' + '0b'.repeat(56), '0x' + 'a'.repeat(40)),
      trade('0x' + '0c'.repeat(56), '0x' + 'b'.repeat(40)),
    ];
    const { runFetcher } = await import('../src/fetcher.js');
    const { runPricer } = await import('../src/pricer.js');
    const { getWalletStatus } = await import('../src/tierer.js');
    const { sql } = await import('../src/db/index.js');

    // Owner-centric fetch: register the wallets under test so runFetcher fetches them.
    for (const w of ['a'.repeat(40), 'b'.repeat(40)]) {
      await sql`INSERT INTO tracked_wallets (wallet) VALUES (decode(${w}, 'hex')) ON CONFLICT (wallet) DO NOTHING`;
    }

    await runFetcher();
    await runPricer();
    await runScorer();

    // Each WETH trade is 1 WETH × 2500 USDC/WETH = $2500 USD.
    // Wallet A had 2 trades → $5000 → silver. Wallet B had 1 → $2500 → bronze.
    const a = await getWalletStatus(('0x' + 'a'.repeat(40)) as `0x${string}`);
    const b = await getWalletStatus(('0x' + 'b'.repeat(40)) as `0x${string}`);
    expect(a.tier.name).toBe('silver');
    expect(a.volume_30d_usd).toBeCloseTo(5000, 0);
    expect(b.tier.name).toBe('bronze');
    expect(b.volume_30d_usd).toBeCloseTo(2500, 0);
  });

  it('replay idempotency: running fetcher twice produces identical DB state', async () => {
    handlers.trades = [trade('0x' + '0d'.repeat(56), '0x' + 'a'.repeat(40))];
    const { runFetcher } = await import('../src/fetcher.js');
    const { sql } = await import('../src/db/index.js');

    await sql`INSERT INTO tracked_wallets (wallet) VALUES (decode(${'a'.repeat(40)}, 'hex')) ON CONFLICT (wallet) DO NOTHING`;
    await runFetcher();
    const snap1 = await sql`SELECT * FROM trades ORDER BY trade_uid`;
    await runFetcher();
    const snap2 = await sql`SELECT * FROM trades ORDER BY trade_uid`;
    expect(snap2.length).toBe(snap1.length);
    expect(snap2.map((r: any) => r.trade_uid.toString('hex')))
      .toEqual(snap1.map((r: any) => r.trade_uid.toString('hex')));
  });
});
