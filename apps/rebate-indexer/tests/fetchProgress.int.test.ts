import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';

const mocks = vi.hoisted(() => ({ trades: vi.fn(), order: vi.fn() }));
vi.mock('../src/cow/client.js', () => ({
  SUPPORTED_CHAIN_IDS: [100, 130],
  listTrades: mocks.trades,
  getOrder: mocks.order,
  hasAccountOrders: vi.fn(async () => false),
}));

const owner = `0x${'aa'.repeat(20)}` as const;
const uid = `0x${'bb'.repeat(56)}` as const;
const token = `0x${'cc'.repeat(20)}`;
let pg: StartedPostgreSqlContainer;
let sql: typeof import('../src/db/index.js')['sql'];
let runFetcher: typeof import('../src/fetcher.js')['runFetcher'];

beforeAll(async () => {
  const started = await startPg();
  pg = started.container;
  process.env.DATABASE_URL = started.connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  await (await import('../src/db/migrate.js')).runMigrations();
  ({ runFetcher } = await import('../src/fetcher.js'));
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await stopPg(pg);
});

beforeEach(async () => {
  await sql`TRUNCATE tracked_wallets, trades, defillama_fills, non_ophis_orders, chain_source_fetches CASCADE`;
  await sql`INSERT INTO tracked_wallets (wallet) VALUES (decode(${owner.slice(2)}, 'hex'))`;
  mocks.trades.mockReset().mockImplementation(async ({ chainId, owner: account }) => {
    if (chainId === 130) throw new Error('Unichain VM unavailable');
    if (account !== owner) return [];
    return [{ blockNumber: 100, logIndex: 1, orderUid: uid, owner, sellToken: token, buyToken: token,
      sellAmount: '1000000', buyAmount: '1000000', txHash: `0x${'dd'.repeat(32)}` }];
  });
  mocks.order.mockReset().mockResolvedValue({
    uid, owner, creationDate: new Date().toISOString(), status: 'fulfilled',
    executedSellAmount: '1000000', executedBuyAmount: '1000000',
    fullAppData: JSON.stringify({ appCode: 'ophis', metadata: { partnerFee: {
      recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8', volumeBps: 1,
    } } }),
  });
});

const deps = { getSettlementTimestamp: async () => new Date() };
afterEach(() => vi.unstubAllEnvs());

it('records success independently and retries only the failed chain within a boundary', async () => {
  const boundary = new Date(Date.now() - 1_000);
  expect((await runFetcher(deps, { staleBefore: boundary })).inserted).toBe(1);
  const first = await sql`SELECT chain_id, last_success_at, failed FROM wallet_chain_fetches ORDER BY chain_id`;
  expect(first.map(r => [r.chain_id, r.failed])).toEqual([[100, false], [130, true]]);
  expect(first[0]!.last_success_at).not.toBeNull();
  expect(first[1]!.last_success_at).toBeNull();
  expect((await runFetcher(deps, { staleBefore: boundary })).inserted).toBe(0);
  expect(mocks.trades.mock.calls.filter(([p]) => p.chainId === 100)).toHaveLength(1);
  expect(mocks.trades.mock.calls.filter(([p]) => p.chainId === 130 && p.owner === owner)).toHaveLength(2);
  await (await import('../src/scorer.js')).runScorer();
  const coverage = await (await import('../src/freshness.js')).readPublicDataFreshness(sql);
  expect(coverage.dataFresh).toBe(false);
  expect(coverage.dataSources?.find(source => source.chainId === 130)?.status).toBe('unavailable');
});

it('counts actual inserts when a completed trade is encountered again', async () => {
  expect((await runFetcher(deps)).inserted).toBe(1);
  await sql`UPDATE wallet_chain_fetches SET last_success_at = NULL`;
  expect((await runFetcher(deps)).inserted).toBe(0);
  const [row] = await sql`SELECT count(*)::int AS count FROM trades`;
  expect(row!.count).toBe(1);
});

it('rebuilds recently fetched chains after replay clears their progress', async () => {
  expect((await runFetcher(deps)).inserted).toBe(1);
  await sql`TRUNCATE trades, defillama_fills, wallet_chain_fetches, chain_source_fetches RESTART IDENTITY CASCADE`;
  await sql`UPDATE tracked_wallets SET last_fetched = NULL`;
  expect((await runFetcher(deps)).inserted).toBe(1);
  expect(mocks.trades.mock.calls.filter(([p]) => p.chainId === 100)).toHaveLength(2);
});

it('rotates proven wallets by attempt age before registration recency', async () => {
  await runFetcher(deps);
  const older = `0x${'11'.repeat(20)}`;
  const unproven = `0x${'22'.repeat(20)}`;
  await sql`INSERT INTO tracked_wallets (wallet, last_registered_at, last_attempt_at)
    VALUES (decode(${older.slice(2)}, 'hex'), now() - interval '30 days', now() - interval '1 day'),
      (decode(${unproven.slice(2)}, 'hex'), now(), NULL)`;
  await sql`INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code)
    SELECT decode(${'99'.repeat(56)}, 'hex'), chain_id, decode(${older.slice(2)}, 'hex'), block_number,
      block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code FROM trades LIMIT 1`;
  await sql`UPDATE wallet_chain_fetches SET last_success_at = now() - interval '1 day'`;
  mocks.trades.mockClear();
  await runFetcher(deps, { staleBefore: new Date() });
  expect(mocks.trades.mock.calls.filter(([p]) => p.chainId === 100).map(([p]) => p.owner))
    .toEqual([older, owner, unproven]);
});

it('reports a synthetic-owner failure even when the tracked wallet succeeds', async () => {
  mocks.trades.mockImplementation(async ({ chainId, owner: account }) => {
    if (chainId === 130 && account !== owner) throw new Error('router metadata unavailable');
    return [];
  });
  await runFetcher(deps);
  const [tracked] = await sql`SELECT failed FROM wallet_chain_fetches WHERE chain_id = 130`;
  const [synthetic] = await sql`SELECT failed FROM chain_source_fetches WHERE chain_id = 130 AND source = 'ethflow'`;
  expect(tracked!.failed).toBe(false);
  expect(synthetic!.failed).toBe(true);
  await (await import('../src/scorer.js')).runScorer();
  const coverage = await (await import('../src/freshness.js')).readPublicDataFreshness(sql);
  expect(coverage.dataSources?.find(source => source.chainId === 130)?.status).toBe('partial');
  expect(coverage.dataSources?.find(source => source.chainId === 130)?.failedWallets).toBe(0);
  expect(coverage.dataFresh).toBe(false);
});

it('includes an incomplete configured decoder in chain coverage', async () => {
  vi.stubEnv('SETTLE_DECODER_CHAINS', '5042');
  await sql`INSERT INTO wallet_chain_fetches (wallet, chain_id, last_success_at)
    VALUES (decode(${owner.slice(2)}, 'hex'), 5042, now())`;
  await sql`INSERT INTO chain_source_fetches (source, chain_id, failed) VALUES ('decoder', 5042, true)`;
  const coverage = await (await import('../src/freshness.js')).readPublicDataFreshness(sql);
  expect(coverage.dataSources?.find(source => source.chainId === 5042)?.status).toBe('partial');
  expect(coverage.dataSources?.find(source => source.chainId === 5042)?.failedWallets).toBe(0);
});
