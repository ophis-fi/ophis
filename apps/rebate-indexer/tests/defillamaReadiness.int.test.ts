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
    expect(await isDefiLlamaBackfillComplete()).toBe(true);
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
});
