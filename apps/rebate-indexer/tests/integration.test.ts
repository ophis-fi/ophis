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

describe('discovery-only decoder (fee_verified upsert arms)', () => {
  it('API verified fee upgrades a decoder discovery row; a decoder write never downgrades a verified row', async () => {
    const { sql } = await import('../src/db/index.js');
    await sql`TRUNCATE trades, tracked_wallets`;
    // MIRRORS the upsert in src/fetcher.ts (upsertTrades): UPGRADE-only via two disjoint
    // arms — (1) a still-NULL row -> a POSITIVE rate (self-heal), and (2) a settle()
    // decoder DISCOVERY row (fee_verified=false) -> the API's verified fee. A decoder
    // write (excluded.fee_verified=false) satisfies neither arm, so it can only INSERT
    // and never overwrites an existing row. Keep in sync with the fetcher.
    const upsert = (uid: string, w: string, fee: number | null, verified: boolean) => sql`
      INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, volume_fee_bps, fee_verified)
      VALUES (decode(${uid.repeat(56)}, 'hex'), 100, decode(${w}, 'hex'), 1, ${RECENT_ISO}, decode(${'11'.repeat(20)}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis', 2500, ${fee}, ${verified})
      ON CONFLICT (trade_uid) DO UPDATE
        SET volume_fee_bps = excluded.volume_fee_bps, fee_verified = excluded.fee_verified
        WHERE (trades.volume_fee_bps IS NULL AND excluded.volume_fee_bps > 0)
           OR (trades.fee_verified = false AND excluded.fee_verified = true)`;
    const read = async (uid: string): Promise<{ fee: number | null; v: boolean }> => {
      const [r] = await sql<{ fee: number | null; v: boolean }[]>`
        SELECT volume_fee_bps AS fee, fee_verified AS v FROM trades WHERE trade_uid = decode(${uid.repeat(56)}, 'hex')`;
      return { fee: r?.fee == null ? null : Number(r.fee), v: r?.v ?? false };
    };
    // decoder discovery first (0, unverified) -> API confirms (10, verified): UPGRADE
    await upsert('d1', 'a'.repeat(40), 0, false);
    await upsert('d1', 'a'.repeat(40), 10, true);
    expect(await read('d1')).toEqual({ fee: 10, v: true });
    // API confirmed first (10, verified) -> decoder (0, unverified): NO DOWNGRADE
    await upsert('d2', 'b'.repeat(40), 10, true);
    await upsert('d2', 'b'.repeat(40), 0, false);
    expect(await read('d2')).toEqual({ fee: 10, v: true });
    // existing NULL self-heal preserved: NULL -> positive upgrades; NULL + 0 stays NULL
    await upsert('d3', 'c'.repeat(40), null, true);
    await upsert('d3', 'c'.repeat(40), 10, true);
    expect((await read('d3')).fee).toBe(10);
    await upsert('d4', 'd'.repeat(40), null, true);
    await upsert('d4', 'd'.repeat(40), 0, true); // re-fetch yields 0 -> must NOT reclassify history
    expect((await read('d4')).fee).toBeNull();
    await sql`TRUNCATE trades, tracked_wallets`;
  }, 30_000);

  it('a discovery row (fee=0) is EXCLUDED from the wallets matview but COUNTED by the /stats query', async () => {
    const { sql } = await import('../src/db/index.js');
    await sql`TRUNCATE trades, tracked_wallets`;
    const wDisc = 'e'.repeat(40);
    // a decoder discovery row: volume_fee_bps = 0, fee_verified = false
    await sql`
      INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, volume_fee_bps, fee_verified)
      VALUES (decode(${'d5'.repeat(56)}, 'hex'), 100, decode(${wDisc}, 'hex'), 1, ${RECENT_ISO}, decode(${'11'.repeat(20)}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis', 2500, 0, false)`;
    await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
    const [inMatview] = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM wallets WHERE wallet = decode(${wDisc}, 'hex')`;
    expect(Number(inMatview?.n ?? '0')).toBe(0); // money path (tier/rank/pool) excludes it
    // mirrors api.ts:/stats (SUM(value_usd), COUNT(*) FROM trades, no fee filter)
    const [stats] = await sql<{ n: string; vol: string }[]>`SELECT COUNT(*)::text AS n, COALESCE(SUM(value_usd),0)::text AS vol FROM trades WHERE chain_id = 100`;
    expect(Number(stats?.n ?? '0')).toBe(1); // discovery visibility
    expect(Number(stats?.vol ?? '0')).toBe(2500);
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

describe('GET /earnings/:appCode (getIntegratorEarnings)', () => {
  const OPHIS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'; // the Ophis Safe (base fee)
  const RECIP_A = 'a1'.repeat(20); // verified production own-fee recipient (hex, no 0x)
  const RECIP_B = 'b2'.repeat(20); // unverified discovery own-fee recipient
  const RECIP_Z = 'cc'.repeat(20); // testnet own-fee recipient

  // Insert one trade with exactly the columns the earnings surface reads.
  const insertTrade = (
    sql: any,
    o: {
      uid: string; chain: number; code: string; feeBps: number | null; verified: boolean;
      volumeUsd: number; ownFeeBps: number | null; ownRecipHex: string | null; ts: string;
    },
  ) => sql`
    INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, volume_fee_bps, fee_verified, appdata_ref_code, own_fee_bps, own_fee_recipient)
    VALUES (decode(${o.uid.repeat(56)}, 'hex'), ${o.chain}, decode(${'ab'.repeat(20)}, 'hex'), 1, ${o.ts}, decode(${'11'.repeat(20)}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis', ${o.volumeUsd}, ${o.feeBps}, ${o.verified}, ${o.code}, ${o.ownFeeBps}, ${o.ownRecipHex ? Buffer.from(o.ownRecipHex, 'hex') : null})`;

  const OLDER = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const NEWER = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

  it('excludes UNVERIFIED discovery rows (fee=0, fee_verified=false) that share the appCode tag', async () => {
    const { sql } = await import('../src/db/index.js');
    const { getIntegratorEarnings } = await import('../src/earnings.js');
    await sql`TRUNCATE trades, tracked_wallets`;
    // Verified, fee-paying row -> counts. Discovery row (attacker-controllable appData
    // tag, forced to volume_fee_bps=0 + fee_verified=false) -> MUST NOT count, even
    // though it carries the same appdata_ref_code and a NEWER own-fee recipient.
    await insertTrade(sql, { uid: 'e1', chain: 100, code: 'mycode', feeBps: 10, verified: true, volumeUsd: 1000, ownFeeBps: 25, ownRecipHex: RECIP_A, ts: OLDER });
    await insertTrade(sql, { uid: 'e2', chain: 100, code: 'mycode', feeBps: 0, verified: false, volumeUsd: 9999, ownFeeBps: 50, ownRecipHex: RECIP_B, ts: NEWER });

    const e = await getIntegratorEarnings('mycode', new Date());
    expect(e.routedVolumeUsd.total).toBe(1000); // discovery 9999 excluded
    expect(e.byChain.find((c) => c.chainId === 100)!.trades).toBe(1);
    expect(e.ophisFeeAccruedUsd.total).toBe(1); // 1000 * 10 / 10_000, gross
    expect(e.ownFeeAccruedUsd.hostedAccrued).toBe(1.875); // 1000 * 25 / 10_000 * 0.75 hosted keep
    // The recipient is the VERIFIED row's, never the newer unverified discovery row's.
    expect(e.ownFeeAccruedUsd.recipient).toBe(`0x${RECIP_A}`);
    await sql`TRUNCATE trades, tracked_wallets`;
  }, 30_000);

  it('scopes the own-fee recipient lookup to production chains (a newer testnet row cannot set it)', async () => {
    const { sql } = await import('../src/db/index.js');
    const { getIntegratorEarnings } = await import('../src/earnings.js');
    await sql`TRUNCATE trades, tracked_wallets`;
    // Production (Gnosis 100) row is OLDER; a verified Sepolia (11155111, testnet, not in
    // PRODUCTION_CHAIN_IDS) row is NEWER. The aggregate already filters to production, so
    // its recipient lookup must too, else the testnet recipient leaks as "where it paid out".
    await insertTrade(sql, { uid: 'c1', chain: 100, code: 'chaincode', feeBps: 10, verified: true, volumeUsd: 1000, ownFeeBps: 25, ownRecipHex: RECIP_A, ts: OLDER });
    await insertTrade(sql, { uid: 'c2', chain: 11155111, code: 'chaincode', feeBps: 10, verified: true, volumeUsd: 500, ownFeeBps: 25, ownRecipHex: RECIP_Z, ts: NEWER });

    const e = await getIntegratorEarnings('chaincode', new Date());
    expect(e.routedVolumeUsd.total).toBe(1000); // testnet 500 excluded from amounts
    expect(e.ownFeeAccruedUsd.recipient).toBe(`0x${RECIP_A}`); // NOT the newer testnet recipient
    await sql`TRUNCATE trades, tracked_wallets`;
  }, 30_000);

  it('backfills own-fee columns on a verified pre-0014 row without rewriting the verified Ophis fee', async () => {
    const { sql } = await import('../src/db/index.js');
    const { backfillOwnFee } = await import('../src/fetcher.js');
    await sql`TRUNCATE trades, tracked_wallets`;
    const INTEGRATOR = 'c1'.repeat(20); // the integrator's stacked own-fee recipient
    // A verified, fee-paying row indexed BEFORE 0014: own_fee columns NULL.
    await insertTrade(sql, { uid: 'f1', chain: 100, code: 'bfcode', feeBps: 10, verified: true, volumeUsd: 1000, ownFeeBps: null, ownRecipHex: null, ts: OLDER });
    // An unverified discovery row must NOT be picked up by the backfill (it re-enriches
    // via the fetcher's upsert arm 2, not here).
    await insertTrade(sql, { uid: 'f2', chain: 100, code: 'bfcode', feeBps: 0, verified: false, volumeUsd: 1000, ownFeeBps: null, ownRecipHex: null, ts: NEWER });

    // Stub the order read: a stacked partnerFee array (Ophis base + the integrator's own
    // 25 bps entry). No network / msw needed.
    const res = await backfillOwnFee(500, {
      getOrder: async () => ({
        fullAppData: JSON.stringify({
          metadata: { partnerFee: [{ volumeBps: 5, recipient: OPHIS }, { volumeBps: 25, recipient: `0x${INTEGRATOR}` }] },
        }),
      }),
    });
    expect(res.updated).toBe(1); // only the verified NULL-own-fee row

    const [f1] = await sql<{ own_bps: number | null; own_recip: string | null; fee: number | null; v: boolean }[]>`
      SELECT own_fee_bps AS own_bps, encode(own_fee_recipient, 'hex') AS own_recip, volume_fee_bps AS fee, fee_verified AS v
      FROM trades WHERE trade_uid = decode(${'f1'.repeat(56)}, 'hex')`;
    expect(Number(f1?.own_bps)).toBe(25); // backfilled
    expect(f1?.own_recip).toBe(INTEGRATOR); // recipient backfilled
    expect(Number(f1?.fee)).toBe(10); // verified Ophis fee UNCHANGED
    expect(f1?.v).toBe(true); // fee_verified UNCHANGED (idempotence preserved)

    const [f2] = await sql<{ own_bps: number | null }[]>`
      SELECT own_fee_bps AS own_bps FROM trades WHERE trade_uid = decode(${'f2'.repeat(56)}, 'hex')`;
    expect(f2?.own_bps).toBeNull(); // discovery row untouched by the backfill
    await sql`TRUNCATE trades, tracked_wallets`;
  }, 30_000);
});
