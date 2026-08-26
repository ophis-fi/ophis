import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';
import type { PendingDefiLlamaFill } from '../src/fetcher.js';
import { readFileSync } from 'node:fs';

// upsertDefillamaFills must UPGRADE a provisional decoder fill (fee_verified=false,
// ToB-B1 discovery posture) in place when the owner-scoped API later serves the
// authoritative fee for the same (chain, block, logIndex, uid), and must NEVER
// downgrade a verified row. Without the upgrade arm the provisional row survives
// onConflictDoNothing forever and computeDefiLlamaDay (verified-only) permanently
// omits the fill.
let container: StartedPostgreSqlContainer;
let sql: any;
let upsertDefillamaFills: typeof import('../src/fetcher.js')['upsertDefillamaFills'];

const UID = `0x${'07'.padStart(112, '0')}` as `0x${string}`;
const fill = (over: Partial<PendingDefiLlamaFill>): PendingDefiLlamaFill => ({
  chainId: 100,
  blockNumber: 42n,
  logIndex: 3,
  tradeUid: UID,
  transactionHash: `0x${'33'.repeat(32)}`,
  userAddress: `0x${'44'.repeat(20)}`,
  settlementTimestamp: new Date('2026-08-01T12:00:00Z'),
  sellToken: `0x${'11'.repeat(20)}`,
  sellAmount: 1_000n,
  buyToken: `0x${'22'.repeat(20)}`,
  buyAmount: 2_000n,
  volumeFeeBps: 0,
  assessedFeeBps: null,
  feeVerified: false,
  ...over,
});

async function readRow() {
  const [row] = await sql<{ bps: number | null; assessed: string | null; verified: boolean; sell: string; user: string }[]>`
    SELECT volume_fee_bps AS bps, assessed_fee_bps::text AS assessed,
           fee_verified AS verified, sell_amount::text AS sell,
           encode(user_address, 'hex') AS user
    FROM defillama_fills
    WHERE chain_id = 100 AND block_number = 42 AND log_index = 3
      AND trade_uid = decode(${UID.slice(2)}, 'hex')`;
  return row!;
}

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ upsertDefillamaFills } = await import('../src/fetcher.js'));
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('upsertDefillamaFills', () => {
  it('inserts a provisional discovery fill', async () => {
    await upsertDefillamaFills([fill({})]);
    expect(await readRow()).toMatchObject({ bps: 0, verified: false });
  });

  it('upgrades the provisional row in place on a verified write', async () => {
    await upsertDefillamaFills([fill({ volumeFeeBps: 1, assessedFeeBps: '2.50000000', feeVerified: true })]);
    const row = await readRow();
    expect(row).toMatchObject({ bps: 1, assessed: '2.50000000', verified: true });
    // Upgrade touches the FEE fields only; the per-fill amounts stay.
    expect(row.sell).toBe('1000');
  });

  it('never downgrades a verified row back to provisional', async () => {
    await upsertDefillamaFills([fill({ volumeFeeBps: 0, feeVerified: false })]);
    expect(await readRow()).toMatchObject({ bps: 1, assessed: '2.50000000', verified: true });
  });

  it('is idempotent for an identical verified re-write', async () => {
    await upsertDefillamaFills([fill({ volumeFeeBps: 1, assessedFeeBps: '2.50000000', feeVerified: true })]);
    expect(await readRow()).toMatchObject({ bps: 1, assessed: '2.50000000', verified: true });
  });

  it('deduplicates same-key rows within one batch, verified copy winning', async () => {
    // A page-boundary shift can deliver the same fill twice in one flush. One
    // ON CONFLICT DO UPDATE statement cannot touch the same row twice, so
    // without in-batch dedup this whole flush throws a cardinality violation.
    const dup = fill({ blockNumber: 77n, logIndex: 9 });
    await expect(
      upsertDefillamaFills([dup, { ...dup, volumeFeeBps: 1, assessedFeeBps: '2.5', feeVerified: true }]),
    ).resolves.toBeUndefined();
    const [row] = await sql<{ bps: number | null; verified: boolean }[]>`
      SELECT volume_fee_bps AS bps, fee_verified AS verified FROM defillama_fills
      WHERE chain_id = 100 AND block_number = 77 AND log_index = 9
        AND trade_uid = decode(${UID.slice(2)}, 'hex')`;
    // The verified in-batch copy won over the provisional one.
    expect(row).toMatchObject({ bps: 1, verified: true });
  });

  it('lets a verified enrichment correct an already non-null user identity', async () => {
    const wrongUser = `0x${'55'.repeat(20)}` as `0x${string}`;
    await upsertDefillamaFills([fill({ blockNumber: 79n, logIndex: 10, userAddress: wrongUser,
      assessedFeeBps: '1.00000000', feeVerified: true })]);
    await upsertDefillamaFills([fill({ blockNumber: 79n, logIndex: 10,
      assessedFeeBps: '1.00000000', feeVerified: true })]);
    const [row] = await sql<{ user: string }[]>`
      SELECT encode(user_address, 'hex') AS user FROM defillama_fills
      WHERE chain_id = 100 AND block_number = 79 AND log_index = 10
        AND trade_uid = decode(${UID.slice(2)}, 'hex')`;
    expect(row!.user).toBe('44'.repeat(20));
  });

  it('accepts the compounded canonical maximum but rejects values above 100.01 bps', async () => {
    await expect(upsertDefillamaFills([
      fill({ blockNumber: 88n, logIndex: 10, assessedFeeBps: '100.00990000', feeVerified: true }),
    ])).resolves.toBeUndefined();

    await expect(upsertDefillamaFills([
      fill({ blockNumber: 89n, logIndex: 11, assessedFeeBps: '100.01000001', feeVerified: true }),
    ])).rejects.toThrow();
  });

  it('reopens and repopulates the fail-closed backfill when assessments are reset', async () => {
    const wallet = 'ab'.repeat(20);
    const tradeUid = 'cd'.repeat(56);
    const token = 'ef'.repeat(20);
    await sql`INSERT INTO tracked_wallets (wallet, last_fetched)
      VALUES (decode(${wallet}, 'hex'), now()) ON CONFLICT (wallet) DO UPDATE SET last_fetched = now()`;
    await sql`INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code, fee_verified
    ) VALUES (
      decode(${tradeUid}, 'hex'), 10, decode(${wallet}, 'hex'), 1, now(),
      decode(${token}, 'hex'), decode(${token}, 'hex'), 1, 1, 'ophis', true
    )`;
    await sql`DELETE FROM defillama_backfill_wallets`;
    await sql`UPDATE defillama_reporting_state SET completed_at = now() WHERE singleton = true`;

    const migration = readFileSync(new URL('../migrations/0035_assessed_fee_compound_bound.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration);

    const [state] = await sql<{ open: boolean; queued: boolean; fetch_reset: boolean }[]>`
      SELECT
        s.completed_at IS NULL AS open,
        EXISTS(SELECT 1 FROM defillama_backfill_wallets q WHERE q.wallet = decode(${wallet}, 'hex')) AS queued,
        EXISTS(SELECT 1 FROM tracked_wallets t
          WHERE t.wallet = decode(${wallet}, 'hex') AND t.last_fetched IS NULL) AS fetch_reset
      FROM defillama_reporting_state s WHERE s.singleton = true`;
    expect(state).toEqual({ open: true, queued: true, fetch_reset: true });
  });

  it('requeues the UID owner of a verified unresolved partial fill', async () => {
    const owner = '12'.repeat(20);
    const tradeUid = `${'34'.repeat(32)}${owner}${'56'.repeat(4)}`;
    const token = '78'.repeat(20);
    await sql`INSERT INTO tracked_wallets (wallet, last_fetched)
      VALUES (decode(${owner}, 'hex'), now()) ON CONFLICT (wallet) DO UPDATE SET last_fetched = now()`;
    await sql`INSERT INTO defillama_fills (
      chain_id, block_number, log_index, trade_uid, settlement_timestamp,
      sell_token, sell_amount, buy_token, buy_amount, volume_fee_bps,
      assessed_fee_bps, fee_verified
    ) VALUES (
      10, 90, 12, decode(${tradeUid}, 'hex'), now(),
      decode(${token}, 'hex'), 10000, decode(${token}, 'hex'), 9999, 1,
      NULL, true
    )`;
    await sql`DELETE FROM trades WHERE wallet = decode(${owner}, 'hex')`;
    await sql`DELETE FROM defillama_backfill_wallets`;
    await sql`UPDATE defillama_reporting_state SET completed_at = now() WHERE singleton = true`;

    const migration = readFileSync(new URL('../migrations/0036_requeue_partial_fill_owners.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration);

    const [state] = await sql<{ open: boolean; queued: boolean; fetch_reset: boolean }[]>`
      SELECT
        s.completed_at IS NULL AS open,
        EXISTS(SELECT 1 FROM defillama_backfill_wallets q WHERE q.wallet = decode(${owner}, 'hex')) AS queued,
        EXISTS(SELECT 1 FROM tracked_wallets t
          WHERE t.wallet = decode(${owner}, 'hex') AND t.last_fetched IS NULL) AS fetch_reset
      FROM defillama_reporting_state s WHERE s.singleton = true`;
    expect(state).toEqual({ open: true, queued: true, fetch_reset: true });
  });
});
