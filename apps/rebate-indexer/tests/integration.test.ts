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
  http.get(`${COW}/xdai/api/v2/trades`, () => HttpResponse.json(handlers.trades)),
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
  http.get(`${COW}/:chain/api/v2/trades`, () => HttpResponse.json([])),
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

describe('pruneStaleWallets', () => {
  it('evicts only confirmed junk; keeps proven, recently-retried, and recent wallets', async () => {
    const { sql } = await import('../src/db/index.js');
    const { pruneStaleWallets } = await import('../src/fetcher.js');
    await sql`TRUNCATE trades, tracked_wallets`;

    const proven = 'a'.repeat(40);
    // Proven wallet must have a row in `trades` so the prune never touches it.
    await sql`INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code)
      VALUES (decode(${'01'.repeat(56)}, 'hex'), 100, decode(${proven}, 'hex'), 1, now(), decode(${'11'.repeat(20)}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis')`;

    // first_seen / last_fetched / last_attempt_at chosen to hit every prune branch.
    await sql`INSERT INTO tracked_wallets (wallet, first_seen, last_fetched, last_attempt_at) VALUES
      (decode(${proven}, 'hex'),           now() - interval '40 days', now(),                       now()),                       -- proven -> KEEP
      (decode(${'b'.repeat(40)}, 'hex'),   now() - interval '8 days',  now() - interval '8 days',   now() - interval '8 days'),   -- fetched-empty 8d -> EVICT
      (decode(${'c'.repeat(40)}, 'hex'),   now() - interval '3 days',  now() - interval '3 days',   now() - interval '3 days'),   -- fetched-empty 3d -> KEEP
      (decode(${'d'.repeat(40)}, 'hex'),   now() - interval '40 days', NULL,                        now() - interval '31 days'),  -- attempted, never ok, 31d -> EVICT
      (decode(${'e'.repeat(40)}, 'hex'),   now() - interval '40 days', NULL,                        now() - interval '2 days'),   -- attempted 2d ago (retrying) -> KEEP (P2)
      (decode(${'f'.repeat(40)}, 'hex'),   now() - interval '31 days', NULL,                        NULL),                        -- never attempted 31d -> EVICT
      (decode(${'1a'.repeat(20)}, 'hex'),  now() - interval '3 days',  NULL,                        NULL)                         -- never attempted 3d -> KEEP
    `;

    await pruneStaleWallets();
    const rows = await sql<{ w: string }[]>`SELECT encode(wallet, 'hex') AS w FROM tracked_wallets`;
    const survivors = new Set(rows.map((r) => r.w));

    expect(survivors.has('a'.repeat(40))).toBe(true);   // proven
    expect(survivors.has('c'.repeat(40))).toBe(true);   // fetched-empty 3d (< 7d)
    expect(survivors.has('e'.repeat(40))).toBe(true);   // recently retried (P2: a chain outage must not evict it)
    expect(survivors.has('1a'.repeat(20))).toBe(true);  // never attempted, only 3d old
    expect(survivors.has('b'.repeat(40))).toBe(false);  // fetched-empty 8d
    expect(survivors.has('d'.repeat(40))).toBe(false);  // attempted, never ok, 31d
    expect(survivors.has('f'.repeat(40))).toBe(false);  // never attempted, 31d

    await sql`TRUNCATE trades, tracked_wallets`;
  });

  it('skips pruning while a fetch holds the advisory lock (no eviction race)', async () => {
    const { sql } = await import('../src/db/index.js');
    const { pruneStaleWallets, FETCHER_LOCK_KEY } = await import('../src/fetcher.js');
    await sql`TRUNCATE trades, tracked_wallets`;

    // A wallet that the prune predicate WOULD evict (never attempted, 31d old).
    // Stand-in for a wallet an in-flight fetch has selected but not yet written
    // trades for / stamped last_attempt_at on.
    const victim = 'c'.repeat(40);
    await sql`INSERT INTO tracked_wallets (wallet, first_seen, last_fetched, last_attempt_at)
      VALUES (decode(${victim}, 'hex'), now() - interval '31 days', NULL, NULL)`;

    // Simulate a concurrent runFetcher: hold FETCHER_LOCK_KEY on a reserved
    // connection (same mechanism runFetcher uses) for the duration of a prune.
    const fetchConn = await sql.reserve();
    const [held] = await fetchConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${FETCHER_LOCK_KEY}) AS locked`;
    expect(held?.locked).toBe(true);
    try {
      const { pruned } = await pruneStaleWallets();
      expect(pruned).toBe(0); // must skip: the lock is held by the "fetch"
      const stillThere = await sql`SELECT 1 FROM tracked_wallets WHERE wallet = decode(${victim}, 'hex')`;
      expect(stillThere.length).toBe(1); // victim survived
    } finally {
      await fetchConn`SELECT pg_advisory_unlock(${FETCHER_LOCK_KEY})`;
      fetchConn.release();
    }

    // Once the fetch releases the lock, the next prune cycle evicts it normally.
    const { pruned } = await pruneStaleWallets();
    expect(pruned).toBe(1);
    const rows = await sql`SELECT 1 FROM tracked_wallets WHERE wallet = decode(${victim}, 'hex')`;
    expect(rows.length).toBe(0);

    await sql`TRUNCATE trades, tracked_wallets`;
  });
});
