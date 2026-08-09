import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';
import type { PendingDefiLlamaFill } from '../src/fetcher.js';

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
  settlementTimestamp: new Date('2026-08-01T12:00:00Z'),
  sellToken: `0x${'11'.repeat(20)}`,
  sellAmount: 1_000n,
  buyToken: `0x${'22'.repeat(20)}`,
  buyAmount: 2_000n,
  volumeFeeBps: 0,
  feeVerified: false,
  ...over,
});

async function readRow() {
  const [row] = await sql<{ bps: number | null; verified: boolean; sell: string }[]>`
    SELECT volume_fee_bps AS bps, fee_verified AS verified, sell_amount::text AS sell
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
    await upsertDefillamaFills([fill({ volumeFeeBps: 10, feeVerified: true })]);
    const row = await readRow();
    expect(row).toMatchObject({ bps: 10, verified: true });
    // Upgrade touches the FEE fields only; the per-fill amounts stay.
    expect(row.sell).toBe('1000');
  });

  it('never downgrades a verified row back to provisional', async () => {
    await upsertDefillamaFills([fill({ volumeFeeBps: 0, feeVerified: false })]);
    expect(await readRow()).toMatchObject({ bps: 10, verified: true });
  });

  it('is idempotent for an identical verified re-write', async () => {
    await upsertDefillamaFills([fill({ volumeFeeBps: 10, feeVerified: true })]);
    expect(await readRow()).toMatchObject({ bps: 10, verified: true });
  });

  it('deduplicates same-key rows within one batch, verified copy winning', async () => {
    // A page-boundary shift can deliver the same fill twice in one flush. One
    // ON CONFLICT DO UPDATE statement cannot touch the same row twice, so
    // without in-batch dedup this whole flush throws a cardinality violation.
    const dup = fill({ blockNumber: 77n, logIndex: 9 });
    await expect(
      upsertDefillamaFills([dup, { ...dup, volumeFeeBps: 10, feeVerified: true }]),
    ).resolves.toBeUndefined();
    const [row] = await sql<{ bps: number | null; verified: boolean }[]>`
      SELECT volume_fee_bps AS bps, fee_verified AS verified FROM defillama_fills
      WHERE chain_id = 100 AND block_number = 77 AND log_index = 9
        AND trade_uid = decode(${UID.slice(2)}, 'hex')`;
    // The verified in-batch copy won over the provisional one.
    expect(row).toMatchObject({ bps: 10, verified: true });
  });
});
