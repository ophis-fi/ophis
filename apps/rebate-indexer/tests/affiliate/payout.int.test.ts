import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

// Integration harness (testcontainers) for the affiliate payout over-draw RESERVE.
// runAffiliatePayout reads the raw Safe WETH balance, then SUBTRACTS the WETH already
// committed to queued (unsigned) affiliate proposals before planning, so a new cycle can
// never propose against funds earmarked for a prior 'proposing'/'proposed' batch (the
// own-fee reserve class, #771). This exercises the real reserve SQL against live Postgres.

let pg: StartedPostgreSqlContainer;
let sql: any;
let sumQueuedAffiliateOwedWei: typeof import('../../src/affiliate/payout.js')['sumQueuedAffiliateOwedWei'];

// Insert one affiliate batch in a given status with a given owed amount (wei). cycle_month
// is UNIQUE, so each seeded batch carries a distinct month.
async function seedBatch(cycleMonth: string, status: string, owedWei: bigint): Promise<void> {
  await sql`
    INSERT INTO affiliate_batches (cycle_month, total_owed_wei, weth_usd_price, status)
    VALUES (${cycleMonth}, ${owedWei.toString()}, 2500, ${status})`;
}

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations(); // applies migration 0005_affiliate.sql
  ({ sql } = await import('../../src/db/index.js'));
  ({ sumQueuedAffiliateOwedWei } = await import('../../src/affiliate/payout.js'));
}, 180_000);

afterAll(async () => {
  await sql?.end?.();
  await stopPg(pg);
});

beforeEach(async () => {
  await sql`TRUNCATE affiliate_batch_entries, affiliate_batches RESTART IDENTITY`;
});

describe('sumQueuedAffiliateOwedWei -- over-draw reserve for queued affiliate proposals', () => {
  it('returns 0 when there are no open batches', async () => {
    expect(await sumQueuedAffiliateOwedWei()).toBe(0n);
  });

  it("sums total_owed_wei ONLY across 'proposing' + 'proposed' batches", async () => {
    await seedBatch('2026-03-01', 'proposed', 8n * 10n ** 17n); // queued, unsigned -> counts
    await seedBatch('2026-04-01', 'proposing', 2n * 10n ** 17n); // mid-submit -> counts
    await seedBatch('2026-05-01', 'executed', 5n * 10n ** 17n); // already paid -> excluded
    await seedBatch('2026-06-01', 'computing', 3n * 10n ** 17n); // not yet proposed -> excluded
    await seedBatch('2026-01-01', 'failed', 9n * 10n ** 17n); // terminal -> excluded
    await seedBatch('2026-02-01', 'no_recipients', 7n * 10n ** 17n); // terminal -> excluded

    // Only the proposed (8e17) + proposing (2e17) are still committed in the Safe.
    expect(await sumQueuedAffiliateOwedWei()).toBe(10n ** 18n);
  });

  it('reserving the queued amount reduces the available balance below the raw balance', async () => {
    // A prior 'proposed' batch holds 9e17. A raw Safe balance of 1e18 ALONE fits a new 2e17
    // owed, but only 1e17 is truly available once the queued proposal is reserved, so the
    // caller must plan against the reduced (clamped) balance, not the raw one.
    await seedBatch('2026-03-01', 'proposed', 9n * 10n ** 17n);
    const reserved = await sumQueuedAffiliateOwedWei();
    const rawBalance = 10n ** 18n;
    const available = rawBalance > reserved ? rawBalance - reserved : 0n;
    expect(reserved).toBe(9n * 10n ** 17n);
    expect(available).toBe(10n ** 17n); // 1e18 - 9e17
    expect(available).toBeLessThan(2n * 10n ** 17n); // a new 2e17 owed would over-draw
  });

  it('clamps the available balance at 0 when reserved exceeds the raw balance', async () => {
    await seedBatch('2026-03-01', 'proposing', 5n * 10n ** 17n);
    await seedBatch('2026-04-01', 'proposed', 8n * 10n ** 17n);
    const reserved = await sumQueuedAffiliateOwedWei(); // 1.3e18
    const rawBalance = 10n ** 18n; // less than reserved
    const available = rawBalance > reserved ? rawBalance - reserved : 0n;
    expect(reserved).toBe(13n * 10n ** 17n);
    expect(available).toBe(0n); // clamped, never negative
  });
});
