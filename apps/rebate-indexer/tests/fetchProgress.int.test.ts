import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ trades: vi.fn(), order: vi.fn(), decoder: vi.fn() }));
vi.mock('../src/cow/onchain.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/cow/onchain.js')>(),
  runSettleDecoder: mocks.decoder,
}));
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
  mocks.decoder.mockReset().mockResolvedValue(0);
  await sql`TRUNCATE tracked_wallets, trades, defillama_fills, defillama_backfill_wallets, non_ophis_orders, chain_source_fetches CASCADE`;
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
  const first = await sql`SELECT chain_id, last_success_at, covered_through, failed FROM wallet_chain_fetches ORDER BY chain_id`;
  expect(first.map(r => [r.chain_id, r.failed])).toEqual([[100, false], [130, true]]);
  expect(first[0]!.last_success_at).not.toBeNull();
  expect(first[1]!.last_success_at).toBeNull();
  expect(first[0]!.covered_through).not.toBeNull();
  expect(new Date(first[0]!.covered_through).getTime()).toBeLessThanOrEqual(new Date(first[0]!.last_success_at).getTime());
  expect(first[1]!.covered_through).toBeNull();
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

it('rotates proven wallets by attempt age and preserves FIFO for unattempted wallets', async () => {
  await runFetcher(deps);
  const older = `0x${'11'.repeat(20)}`;
  const unproven = `0x${'22'.repeat(20)}`;
  const newcomer = `0x${'33'.repeat(20)}`;
  const retry = `0x${'44'.repeat(20)}`;
  await sql`INSERT INTO tracked_wallets (wallet, first_seen, last_registered_at, last_attempt_at)
    VALUES (decode(${older.slice(2)}, 'hex'), now() - interval '30 days', now() - interval '30 days', now() - interval '1 day'),
      (decode(${unproven.slice(2)}, 'hex'), now() - interval '1 day', now() - interval '1 day', NULL),
      (decode(${newcomer.slice(2)}, 'hex'), now(), now(), NULL),
      (decode(${retry.slice(2)}, 'hex'), now() - interval '2 days', now() - interval '2 days', now() - interval '2 hours')`;
  await sql`INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code)
    SELECT decode(${'99'.repeat(56)}, 'hex'), chain_id, decode(${older.slice(2)}, 'hex'), block_number,
      block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code FROM trades LIMIT 1`;
  await sql`UPDATE wallet_chain_fetches SET last_success_at = now() - interval '1 day'`;
  mocks.trades.mockClear();
  await runFetcher(deps, { staleBefore: new Date() });
  expect(mocks.trades.mock.calls.filter(([p]) => p.chainId === 100).map(([p]) => p.owner))
    .toEqual([older, owner, unproven, retry, newcomer]);
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

it('records decoder completion after a null timestamp and preserves coverage on an incomplete retry', async () => {
  vi.stubEnv('SETTLE_DECODER_CHAINS', '5042');
  mocks.trades.mockResolvedValue([]);
  let coveredThrough: Date | undefined;
  mocks.decoder.mockImplementation(async ({ reportProgress }) => {
    await reportProgress(5042, coveredThrough !== undefined, coveredThrough);
    return 0;
  });
  await runFetcher(deps);
  const [initial] = await sql`SELECT * FROM chain_source_fetches WHERE source = 'decoder' AND chain_id = 5042`;
  expect(initial).toMatchObject({ failed: true, last_success_at: null, covered_through: null });

  coveredThrough = new Date('2026-11-09T07:00:00.000Z');
  await runFetcher(deps);
  const [complete] = await sql`SELECT * FROM chain_source_fetches WHERE source = 'decoder' AND chain_id = 5042`;
  expect(complete!.failed).toBe(false);
  expect(complete!.last_success_at).not.toBeNull();
  expect(new Date(complete!.covered_through)).toEqual(coveredThrough);

  coveredThrough = undefined;
  await runFetcher(deps);
  const [retry] = await sql`SELECT * FROM chain_source_fetches WHERE source = 'decoder' AND chain_id = 5042`;
  expect(retry).toMatchObject({ failed: true, last_success_at: complete!.last_success_at,
    covered_through: complete!.covered_through });

  coveredThrough = new Date('2026-11-09T08:00:00.000Z');
  await runFetcher(deps);
  const [recovered] = await sql`SELECT * FROM chain_source_fetches WHERE source = 'decoder' AND chain_id = 5042`;
  expect(recovered!.failed).toBe(false);
  expect(new Date(recovered!.covered_through)).toEqual(coveredThrough);
});

it('refetches a cached chain after the wallet is requeued at a newer repair boundary', async () => {
  const boundary = new Date(Date.now() - 1_000);
  await runFetcher(deps, { staleBefore: boundary });
  await sql`UPDATE defillama_reporting_state SET backfill_started_at = now()`;
  await sql`INSERT INTO defillama_backfill_wallets (wallet) VALUES (decode(${owner.slice(2)}, 'hex'))`;
  await runFetcher(deps, { staleBefore: boundary });
  expect(mocks.trades.mock.calls.filter(([p]) => p.chainId === 100 && p.owner === owner)).toHaveLength(2);
  expect((await sql`SELECT count(*)::int AS n FROM defillama_backfill_wallets`)[0]!.n).toBe(1);
});

it('does not dequeue a wallet until all production chain pairs cover the repair boundary', async () => {
  const boundary = new Date(Date.now() - 1_000);
  await sql`UPDATE defillama_reporting_state SET backfill_started_at = now()`;
  await sql`INSERT INTO defillama_backfill_wallets (wallet) VALUES (decode(${owner.slice(2)}, 'hex'))`;
  await sql`INSERT INTO wallet_chain_fetches (wallet, chain_id, last_success_at, covered_through)
    SELECT decode(${owner.slice(2)}, 'hex'), c, now(), now() FROM unnest(ARRAY[100,130]) c`;
  await runFetcher(deps, { staleBefore: boundary });
  expect((await sql`SELECT count(*)::int AS n FROM defillama_backfill_wallets`)[0]!.n).toBe(1);
  const { PRODUCTION_CHAIN_IDS } = await import('../src/stats-page.js');
  await sql`INSERT INTO wallet_chain_fetches (wallet, chain_id, last_success_at, covered_through)
    SELECT decode(${owner.slice(2)}, 'hex'), c, now(), now() FROM unnest(${[...PRODUCTION_CHAIN_IDS]}::int[]) c
    ON CONFLICT (wallet, chain_id) DO UPDATE SET last_success_at = now(), covered_through = now(), failed = false`;
  await runFetcher(deps, { staleBefore: boundary });
  expect((await sql`SELECT count(*)::int AS n FROM defillama_backfill_wallets`)[0]!.n).toBe(0);
});

it('requires Arc discovery coverage even when the decoder flag is absent', async () => {
  vi.stubEnv('SETTLE_DECODER_CHAINS', '');
  await sql`INSERT INTO wallet_chain_fetches (wallet, chain_id, last_success_at, covered_through)
    VALUES (decode(${owner.slice(2)}, 'hex'), 5042, now(), now())`;
  await sql`INSERT INTO chain_source_fetches (source, chain_id, last_success_at, covered_through)
    VALUES ('ethflow', 5042, now(), now())`;
  const { readPublicDataFreshness } = await import('../src/freshness.js');
  expect((await readPublicDataFreshness(sql)).dataSources?.find(s => s.chainId === 5042)?.status).toBe('pending');
  await sql`INSERT INTO chain_source_fetches (source, chain_id, last_success_at, covered_through)
    VALUES ('decoder', 5042, now(), now())`;
  expect((await readPublicDataFreshness(sql)).dataSources?.find(s => s.chainId === 5042)?.status).toBe('fresh');
  await sql`UPDATE chain_source_fetches SET covered_through = NULL WHERE source = 'decoder'`;
  expect((await readPublicDataFreshness(sql)).dataSources?.find(s => s.chainId === 5042)?.coveredThrough).toBeNull();
});

it('keeps a previously recorded decoder required after its configuration is removed', async () => {
  vi.stubEnv('SETTLE_DECODER_CHAINS', '');
  mocks.trades.mockResolvedValue([]);
  await runFetcher(deps);
  const { readPublicDataFreshness } = await import('../src/freshness.js');
  expect((await readPublicDataFreshness(sql)).dataSources?.find(s => s.chainId === 100)?.status).toBe('fresh');
  await sql`INSERT INTO chain_source_fetches (source, chain_id, failed) VALUES ('decoder', 100, true)`;
  expect((await readPublicDataFreshness(sql)).dataSources?.find(s => s.chainId === 100)?.status).toBe('partial');
});

it('retains decoder identities and invalidates coverage and cursors during a full replay', async () => {
  await sql`INSERT INTO chain_source_fetches (source, chain_id, last_success_at, covered_through)
    VALUES ('decoder', 100, now(), now())`;
  await sql`INSERT INTO settle_scan_cursor (chain_id, last_block) VALUES (100, 20)`;
  // Exercise the actual reset statements only, against this disposable database.
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const reset = source.split("async ['replay-from-genesis']()", 2)[1]!.split('for (let i = 0;', 1)[0]!;
  const statements = [...reset.matchAll(/await sql`([^`]+)`/g)];
  expect(statements.length).toBeGreaterThan(0);
  for (const [, statement] of statements) {
    expect(statement).not.toContain('${');
    await sql.unsafe(statement!);
  }
  const [decoder] = await sql`SELECT chain_id, last_success_at, covered_through, failed FROM chain_source_fetches`;
  expect(decoder).toMatchObject({ chain_id: 100, last_success_at: null, covered_through: null, failed: true });
  expect((await sql`SELECT count(*)::int AS n FROM settle_scan_cursor`)[0]!.n).toBe(0);
});
