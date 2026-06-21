import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../src/db/migrate.js';
import { runScorer } from '../src/scorer.js';
import { startPg, stopPg } from './fixtures/pgContainer.js';

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
// Relative recent timestamp — the trade's block_timestamp comes from this and the
// `wallets` matview only counts trades within the last 30 days. A hardcoded date
// silently ages out of the window (it did, on 2026-05-31), so compute it from now.
const RECENT_ISO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
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
    // A legit Ophis order carries the partner fee, so it reads volume_fee_bps > 0 and counts
    // toward the trader-volume matview (which now excludes fee-less recognized orders).
    fullAppData: JSON.stringify({
      appCode: 'ophis',
      metadata: { partnerFee: { recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8', bps: 5 } },
    }),
    creationDate: RECENT_ISO,
    status: 'fulfilled',
    executedSellAmount: '1000000000000000000',
    executedBuyAmount: '2500000000',
  }),
};
const server = setupServer(
  // xdai (chainId=100) — the chain under test
  http.get(`${COW}/xdai/api/v2/trades`, () => HttpResponse.json(handlers.trades)),
  http.get(`${COW}/xdai/api/v1/orders/:uid`, ({ params }) => HttpResponse.json(handlers.order(params.uid as string))),
  // Pricer uses CoW's native_price oracle (native-wei per token ATOM). Pick values so
  // 1 WETH prices to $2500: usd = 1e18 * np(WETH) / np(USDC.e) / 10^6 = 1e18*2500/1e12/1e6.
  http.get(`${COW}/xdai/api/v1/token/:token/native_price`, ({ params }) => {
    const t = String(params.token).toLowerCase();
    if (t === '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1') return HttpResponse.json({ price: 2500 }); // WETH
    if (t === '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83') return HttpResponse.json({ price: 1_000_000_000_000 }); // USDC.e ref
    return new HttpResponse(null, { status: 404 }); // NoLiquidity for any other token
  }),
  // Catch-all: return empty trades for all other chains so the fetcher doesn't hit real network.
  http.get(`${COW}/:chain/api/v2/trades`, () => HttpResponse.json([])),
);

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  process.env.COW_API_BASE = COW;
  server.listen();
  await runMigrations();
}, 60_000);

afterAll(async () => {
  server.close();
  await stopPg(pg);
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
    // Wallet A had 2 trades → $5000, Wallet B had 1 → $2500. Both are below the
    // $20k Bronze floor, so both map to the 'none' tier (no rebate weight).
    const a = await getWalletStatus(('0x' + 'a'.repeat(40)) as `0x${string}`);
    const b = await getWalletStatus(('0x' + 'b'.repeat(40)) as `0x${string}`);
    expect(a.tier.name).toBe('none');
    expect(a.volume_30d_usd).toBeCloseTo(5000, 0);
    expect(b.tier.name).toBe('none');
    expect(b.volume_30d_usd).toBeCloseTo(2500, 0);
    // Integration test: real Postgres container + msw HTTP + a 3-stage pipeline
    // (fetch/price/score). The default 5s vitest timeout is too tight under loaded
    // CI runners — and a timeout here leaves this test's async DB writes in flight,
    // which then race the pruneStaleWallets test's TRUNCATE (they share wallet 'b')
    // and flake it. 30s gives ample headroom.
  }, 30_000);

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
  }, 30_000); // integration: container + 2x fetcher — generous timeout (see above)
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
  }, 30_000); // integration: container + prune over a fixtured wallet set
});

describe('wallets matview fee-gate', () => {
  it('excludes recognized trades that paid no Ophis fee (volume_fee_bps = 0); keeps NULL and positive', async () => {
    const { sql } = await import('../src/db/index.js');
    await sql`TRUNCATE trades, tracked_wallets`;
    const wPos = 'a'.repeat(40); // volume_fee_bps = 5 -> counts
    const wNull = 'b'.repeat(40); // NULL (un-backfilled legacy / surplus-PI) -> counts, never under-count a legit un-priced trade
    const wZero = 'c'.repeat(40); // 0 (no Ophis fee, e.g. the 'ophis-fallback' / forged order) -> EXCLUDED
    const ins = (uid: string, w: string, feeBps: number | null) => sql`
      INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, volume_fee_bps)
      VALUES (decode(${uid.repeat(56)}, 'hex'), 100, decode(${w}, 'hex'), 1, ${RECENT_ISO}, decode(${'11'.repeat(20)}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis', 2500, ${feeBps})`;
    await ins('a1', wPos, 5);
    await ins('a2', wNull, null);
    await ins('a3', wZero, 0);
    await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
    const counted = new Set(
      (await sql<{ w: string }[]>`SELECT encode(wallet, 'hex') AS w FROM wallets`).map((r) => r.w),
    );
    expect(counted.has(wPos)).toBe(true); // positive fee counts
    expect(counted.has(wNull)).toBe(true); // NULL kept: a legit un-backfilled trade is never under-counted
    expect(counted.has(wZero)).toBe(false); // zero-fee recognized order excluded from the trader pool
    await sql`TRUNCATE trades, tracked_wallets`;
  }, 30_000);
});

describe('migration 0011 wallets matview', () => {
  it('recreates the matview POPULATED so reads never hit an unpopulated view (upgrade safety)', async () => {
    // On an UPGRADE, index.ts serves the API (index.ts:11) BEFORE the async backfill reaches
    // runScorer (index.ts:31). If 0011 left wallets WITH NO DATA, every /tier and /status read in
    // that window would ERROR ("materialized view has not been populated"). So 0011 must populate
    // the view in-migration. Re-run the ACTUAL migration file and assert it ends up populated.
    const { sql } = await import('../src/db/index.js');
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(new URL('../migrations/0011_wallets_fee_gated.sql', import.meta.url), 'utf8');
    // Replay inside a transaction, exactly as the migration runner does (migrate.ts sql.begin).
    await sql.begin((tx) => tx.unsafe(migration));
    const [row] = await sql<{ is_populated: boolean }[]>`
      SELECT ispopulated AS is_populated FROM pg_matviews WHERE matviewname = 'wallets'`;
    expect(row?.is_populated).toBe(true); // populated at creation -> readable immediately, scorer refreshes CONCURRENTLY
    // A read must NOT throw (the WITH-NO-DATA bug raised "materialized view has not been populated").
    await expect(sql`SELECT COUNT(*)::int AS n FROM wallets`).resolves.toBeDefined();
  }, 30_000);
});
