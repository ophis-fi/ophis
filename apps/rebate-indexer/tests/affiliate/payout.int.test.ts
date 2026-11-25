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

let readAffiliatePayoutInputs: typeof import('../../src/affiliate/payout.js')['readAffiliatePayoutInputs'];
let deferredAffiliateBoundaries: typeof import('../../src/affiliate/payout.js')['deferredAffiliateBoundaries'];
let runAffiliatePayout: typeof import('../../src/affiliate/payout.js')['runAffiliatePayout'];

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
  ({ sumQueuedAffiliateOwedWei, readAffiliatePayoutInputs, deferredAffiliateBoundaries, runAffiliatePayout } = await import('../../src/affiliate/payout.js'));
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


describe('native affiliate monthly cutoff', () => {
  const now = new Date('2026-12-01T02:00:00Z');
  const end = '2026-12-01T00:00:00Z';
  const trader = Buffer.alloc(32, 7);
  const referrer = Buffer.alloc(20, 9);
  const proof = Buffer.alloc(64, 2);

  beforeEach(async () => {
    await sql`TRUNCATE referrals, ref_codes, solana_settled_fills, affiliate_deferred_cycles`;
    await sql`UPDATE solana_fill_sync SET covered_block_timestamp = null`;
    await sql`INSERT INTO ref_codes(code, referrer_wallet, kind) VALUES ('solaffiliate', ${referrer}, 'regular')`;
  });
  const bind = (bytes: Buffer, at: string) => sql`INSERT INTO referrals(referred_wallet,code,referrer_wallet,net_new,bound_at)
    VALUES (${bytes}, 'solaffiliate', ${referrer}, true, ${at})`;
  const fill = (when: string, who = trader) => sql`
    INSERT INTO solana_settled_fills(tx_signature,instruction_index,order_uid,slot,block_timestamp,wallet,
      sell_mint,buy_mint,sell_atoms,buy_atoms)
    VALUES (${proof},0,${trader},100,${when},${who},${trader},${trader},1,1)`;

  it('defers a relevant cycle without creating a batch or querying an RPC, then retries across month rollover', async () => {
    await bind(trader, '2026-11-01T00:00:00Z');
    await sql`UPDATE solana_fill_sync SET covered_block_timestamp = '2026-11-30T23:59:59Z'`;
    const result = await runAffiliatePayout({ chainId: 100, rpcUrl: 'invalid:', proposerPrivateKey: '0x00', proposeEnabled: false, now });
    expect(result.status).toBe('awaiting_solana');
    expect(await sql`SELECT 1 FROM affiliate_batches`).toHaveLength(0);
    expect(await deferredAffiliateBoundaries(now, true)).toEqual([]);
    expect(await deferredAffiliateBoundaries(now, false)).toEqual([new Date(end)]);
    expect(await deferredAffiliateBoundaries(new Date('2027-01-01T02:00:00Z'), true)).toEqual([new Date(end)]);
    await sql`UPDATE solana_fill_sync SET covered_block_timestamp = ${end}`;
    expect(await readAffiliatePayoutInputs(now)).toEqual([]);
    await seedBatch('2026-11-01', 'no_recipients', 0n);
    expect(await deferredAffiliateBoundaries(now, false)).toEqual([]);
  });

  it('rechecks unknown fees and valuations on earlier eligible fills even after history is covered', async () => {
    await bind(trader, '2026-11-02T00:00:00Z');
    await fill('2026-11-20T00:00:00Z');
    await sql`UPDATE solana_fill_sync SET covered_block_timestamp = ${end}`;
    expect(await readAffiliatePayoutInputs(now)).toBeNull();
    await sql`UPDATE solana_settled_fills SET base_fee_atoms = 3, base_fee_usd = 0.03`;
    expect(await readAffiliatePayoutInputs(now)).toBeNull();
    await sql`UPDATE solana_settled_fills SET value_usd = 300, base_fee_usd = NULL`;
    expect(await readAffiliatePayoutInputs(now)).toBeNull();
    await sql`UPDATE solana_settled_fills SET base_fee_usd = 0.03`;
    expect(await readAffiliatePayoutInputs(now)).toMatchObject([{ buckets: [{ chainId: -1, volumeUsd: 300, grossBps: 1 }] }]);
    await sql`UPDATE solana_settled_fills SET base_fee_atoms = 0, base_fee_usd = null, value_usd = null`;
    expect(await readAffiliatePayoutInputs(now)).toEqual([]);
  });

  it('does not hold a historical EVM-only cycle or count ineligible or out-of-period native fills', async () => {
    await bind(Buffer.alloc(20, 1), '2026-10-01T00:00:00Z');
    await bind(Buffer.alloc(32, 1), end);
    expect(await readAffiliatePayoutInputs(now)).toEqual([]);
    await bind(trader, '2026-11-10T00:00:00Z');
    await fill('2026-11-01T00:00:00Z'); // importer later discovers this was a returning trader
    expect(await readAffiliatePayoutInputs(now)).toEqual([]);
    await sql`TRUNCATE solana_settled_fills`;
    await sql`UPDATE solana_fill_sync SET covered_block_timestamp = ${end}`;
    await fill(end); // belongs to the next cycle
    expect(await readAffiliatePayoutInputs(now)).toEqual([]);
    await sql`TRUNCATE solana_settled_fills`;
    await fill('2026-11-20T00:00:00Z', Buffer.alloc(32, 99)); // unrelated trader
    expect(await readAffiliatePayoutInputs(now)).toEqual([]);
  });
});
