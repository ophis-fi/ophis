import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';

let container: StartedPostgreSqlContainer;
let sql: any;
let isDefiLlamaBackfillComplete: typeof import('../src/defillamaBackfill.js')['isDefiLlamaBackfillComplete'];

const UID = '11'.repeat(56);
const WALLET = '22'.repeat(20);
const TOKEN = '33'.repeat(20);
const TX = '44'.repeat(32);
const AT = '2026-08-20T12:00:00.000Z';
const DECODER_UID = '66'.repeat(56);

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ isDefiLlamaBackfillComplete } = await import('../src/defillamaBackfill.js'));

  await sql`DELETE FROM defillama_backfill_wallets`;
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code, fee_verified,
      defillama_expected_fill_count, defillama_repair_checked_at)
    VALUES (
      decode(${UID}, 'hex'), 1, decode(${WALLET}, 'hex'), 10, ${AT},
      decode(${TOKEN}, 'hex'), decode(${TOKEN}, 'hex'), 100, 100, 'ophis', true,
      1, now())`;
  await sql`
    INSERT INTO defillama_fills (
      chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
      settlement_timestamp, sell_token, sell_amount, buy_token, buy_amount,
      volume_fee_bps, assessed_fee_bps, fee_verified, value_usd, priced_at)
    VALUES (
      1, 10, 1, decode(${UID}, 'hex'), decode(${TX}, 'hex'), decode(${WALLET}, 'hex'),
      ${AT}, decode(${TOKEN}, 'hex'), 100, decode(${TOKEN}, 'hex'), 100,
      1, NULL, true, 10, ${AT})`;
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('DefiLlama readiness', () => {
  it('stays closed until every production fill has an exact executed assessment', async () => {
    expect(await isDefiLlamaBackfillComplete()).toBe(false);
    await sql`UPDATE defillama_fills SET assessed_fee_bps = 1 WHERE chain_id = 1`;
    expect(await isDefiLlamaBackfillComplete()).toBe(false);
  });

  it('requires the Arc reconciliation acknowledgement even with complete known rows and an old completion timestamp', async () => {
    await sql`UPDATE defillama_reporting_state SET completed_at = now()`;
    expect(await isDefiLlamaBackfillComplete()).toBe(false);
    const { completeDefiLlamaBackfillIfReady } = await import('../src/defillamaBackfill.js');
    expect(await completeDefiLlamaBackfillIfReady()).toBe(false);
    await sql`UPDATE defillama_reporting_state SET arc_reconciled_through_block = 23345455`;
    expect(await isDefiLlamaBackfillComplete()).toBe(true);
    expect(await isDefiLlamaBackfillComplete(999999)).toBe(false);
  });

  it('ignores accidental testnet rows', async () => {
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, settlement_timestamp,
        sell_token, sell_amount, fee_verified)
      VALUES (
        11155111, 20, 1, decode(${'55'.repeat(56)}, 'hex'), ${AT},
        decode(${TOKEN}, 'hex'), 1, false)`;
    expect(await isDefiLlamaBackfillComplete()).toBe(true);
  });

  it('closes when the persisted expected fill count does not match the ledger', async () => {
    await sql`UPDATE trades SET defillama_expected_fill_count = 2 WHERE trade_uid = decode(${UID}, 'hex')`;
    expect(await isDefiLlamaBackfillComplete()).toBe(false);
  });

  it('requires a completeness audit for decoder-only aggregates with known fills', async () => {
    await sql`UPDATE trades SET defillama_expected_fill_count = 1 WHERE trade_uid = decode(${UID}, 'hex')`;
    await sql`
      INSERT INTO trades (
        trade_uid, chain_id, wallet, block_number, block_timestamp,
        sell_token, buy_token, sell_amount, buy_amount, app_code, fee_verified)
      VALUES (
        decode(${DECODER_UID}, 'hex'), 1, decode(${WALLET}, 'hex'), 30, ${AT},
        decode(${TOKEN}, 'hex'), decode(${TOKEN}, 'hex'), 100, 100, 'ophis', false)`;
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
        settlement_timestamp, sell_token, sell_amount, buy_token, buy_amount,
        volume_fee_bps, assessed_fee_bps, fee_verified, value_usd, priced_at)
      VALUES (
        1, 30, 1, decode(${DECODER_UID}, 'hex'), decode(${'77'.repeat(32)}, 'hex'),
        decode(${WALLET}, 'hex'), ${AT}, decode(${TOKEN}, 'hex'), 100,
        decode(${TOKEN}, 'hex'), 100, 1, 1, true, 10, ${AT})`;

    expect(await isDefiLlamaBackfillComplete()).toBe(false);
    await sql`
      UPDATE trades SET defillama_expected_fill_count = 1, defillama_repair_checked_at = now()
      WHERE trade_uid = decode(${DECODER_UID}, 'hex')`;
    expect(await isDefiLlamaBackfillComplete()).toBe(true);
  });

  it('serves a proved chain while Unichain remains incomplete, without opening global reporting', async () => {
    await sql`UPDATE defillama_reporting_state SET backfill_started_at = now(), arc_reconciled_through_block = NULL`;
    await sql`INSERT INTO tracked_wallets (wallet) VALUES (decode(${WALLET}, 'hex')) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO defillama_backfill_wallets (wallet) VALUES (decode(${WALLET}, 'hex'))`;
    await sql`INSERT INTO wallet_chain_fetches (wallet, chain_id, last_success_at, covered_through)
      SELECT wallet, 1, now(), now() FROM tracked_wallets`;
    await sql`INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code, fee_verified)
      VALUES (decode(${'88'.repeat(56)}, 'hex'), 130, decode(${WALLET}, 'hex'), 40, ${AT},
      decode(${TOKEN}, 'hex'), decode(${TOKEN}, 'hex'), 100, 100, 'ophis', true)`;
    await sql`INSERT INTO defillama_fills (
      chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
      settlement_timestamp, sell_token, sell_amount, fee_verified, value_usd)
      VALUES (130, 40, 1, decode(${'88'.repeat(56)}, 'hex'), decode(${TX}, 'hex'),
      decode(${WALLET}, 'hex'), ${AT}, decode(${TOKEN}, 'hex'), 100, true, 30)`;
    await sql`UPDATE trades SET value_usd = 10 WHERE chain_id = 1`;

    expect(await isDefiLlamaBackfillComplete(1)).toBe(true);
    expect(await isDefiLlamaBackfillComplete(130)).toBe(false);
    expect(await isDefiLlamaBackfillComplete(5042)).toBe(false);
    expect(await isDefiLlamaBackfillComplete()).toBe(false);

    const { buildApiServer } = await import('../src/api.js');
    const app = await buildApiServer();
    try {
      const response = await app.inject({ url: '/defillama?date=2026-08-20&chainId=1' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ chainId: 1, totals: { volumeUsd: 20, trades: 2, users: 1 } });
      expect(response.json().chains.map((c: { chainId: number }) => c.chainId)).toEqual([1]);
      expect((await app.inject({ url: '/defillama?date=2026-08-20&chainId=130' })).statusCode).toBe(503);
      expect((await app.inject({ url: '/defillama?date=2026-08-20' })).statusCode).toBe(503);
      expect((await app.inject({ url: '/defillama?date=2026-08-20&chainId=56' })).statusCode).toBe(503);
      const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      expect((await app.inject({ url: `/defillama?date=${future}&chainId=1` })).statusCode).toBe(503);
      await sql`DELETE FROM defillama_backfill_wallets`;
      await sql`UPDATE wallet_chain_fetches SET covered_through = NULL WHERE chain_id = 1`;
      expect((await app.inject({ url: '/defillama?date=2026-08-20&chainId=1' })).statusCode).toBe(503);
      await sql`UPDATE wallet_chain_fetches SET covered_through = '2026-08-20T23:59:59Z' WHERE chain_id = 1`;
      expect((await app.inject({ url: '/defillama?date=2026-08-20&chainId=1' })).statusCode).toBe(503);
      await sql`UPDATE wallet_chain_fetches SET covered_through = '2026-08-21T00:00:00Z' WHERE chain_id = 1`;
      expect((await app.inject({ url: '/defillama?date=2026-08-20&chainId=1' })).statusCode).toBe(200);
      await sql`INSERT INTO defillama_backfill_wallets (wallet) VALUES (decode(${WALLET}, 'hex'))`;
      await sql`UPDATE wallet_chain_fetches SET last_success_at = now() - interval '27 hours' WHERE chain_id = 1`;
      expect((await app.inject({ url: '/defillama?date=2026-08-20&chainId=1' })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('requires post-backfill success for each queued wallet on the requested chain', async () => {
    await sql`UPDATE wallet_chain_fetches SET covered_through = now() - interval '27 hours' WHERE chain_id = 1`;
    expect(await isDefiLlamaBackfillComplete(1)).toBe(false);
    await sql`UPDATE wallet_chain_fetches SET last_success_at = now(), failed = true WHERE chain_id = 1`;
    expect(await isDefiLlamaBackfillComplete(1)).toBe(false);
    await sql`UPDATE wallet_chain_fetches SET failed = false, last_success_at = NULL WHERE chain_id = 1`;
    expect(await isDefiLlamaBackfillComplete(1)).toBe(false);
    await sql`UPDATE wallet_chain_fetches SET last_success_at = now(), covered_through = now() WHERE chain_id = 1`;
    expect(await isDefiLlamaBackfillComplete(1)).toBe(true);
    await sql`UPDATE defillama_fills SET assessed_fee_bps = NULL WHERE chain_id = 1 AND block_number = 10`;
    expect(await isDefiLlamaBackfillComplete(1)).toBe(false);
    await sql`UPDATE defillama_fills SET assessed_fee_bps = 1 WHERE chain_id = 1 AND block_number = 10`;
    await sql`UPDATE trades SET defillama_expected_fill_count = 2 WHERE chain_id = 1 AND block_number = 10`;
    expect(await isDefiLlamaBackfillComplete(1)).toBe(false);
    await sql`UPDATE trades SET defillama_expected_fill_count = 1 WHERE chain_id = 1 AND block_number = 10`;
    const { completeDefiLlamaBackfillIfReady } = await import('../src/defillamaBackfill.js');
    expect(await completeDefiLlamaBackfillIfReady()).toBe(false);
    const [state] = await sql`SELECT completed_at FROM defillama_reporting_state`;
    expect(state.completed_at).toBeNull();
    expect((await sql`SELECT count(*)::int AS n FROM defillama_backfill_wallets`)[0].n).toBe(1);
  });
});
