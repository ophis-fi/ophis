import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { startPg, stopPg } from '../fixtures/pgContainer.js';
import { usdFpToWei, usdToFp } from '../../src/partnerFees/split.js';

// testcontainers: partner-fee ACCRUAL money path (partner-fees Phase B) -- 80/20 split, $25
// threshold + carry-over, sanctions screening -> quarantine, trade stamping (no double-count),
// re-accrual idempotency, and the resulting outstanding liability.

const PRICE = 2_000; // USD per WETH (injected)
const R1 = '11'.repeat(20); // paid
const R2 = '22'.repeat(20); // carried (sub-threshold)
const R3 = '33'.repeat(20); // sanctioned -> quarantined
const wei = (usd: number) => usdFpToWei(usdToFp(usd), PRICE);

let pg: StartedPostgreSqlContainer;
let tradeSeq = 0;
async function getSql() {
  return (await import('../../src/db/index.js')).sql;
}
async function seedTrade(sql: Awaited<ReturnType<typeof getSql>>, recipient20: string, feeUsd: number) {
  const u = (tradeSeq++).toString(16).padStart(112, '0');
  await sql`
    INSERT INTO partner_fee_trades (trade_uid, recipient, chain_id, block_number, log_index, volume_bps, fee_token, fee_amount, fee_usd, priced_at)
    VALUES (decode(${u}, 'hex'), decode(${recipient20}, 'hex'), 10, ${tradeSeq}, 0, 30, decode(${'bb'.repeat(20)}, 'hex'), 1000, ${feeUsd}, now())`;
}
async function accrue(now: Date) {
  const { accruePartnerFees } = await import('../../src/partnerFees/payout.js');
  return accruePartnerFees({ now, fetchWethUsdPrice: async () => PRICE, sanctions: new Set([`0x${R3}`]) });
}
async function liability() {
  const { outstandingPartnerLiabilityWei } = await import('../../src/partnerFees/liability.js');
  return outstandingPartnerLiabilityWei();
}

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  await runMigrations();
}, 120_000);

afterAll(async () => stopPg(pg));

beforeEach(async () => {
  const sql = await getSql();
  await sql`TRUNCATE partner_fee_batch_entries, partner_fee_batches, partner_fee_trades RESTART IDENTITY CASCADE`;
});

const JUN = new Date('2026-06-01T02:00:00Z'); // settles 2026-05

describe('partner-fee accrual', () => {
  it('classifies paid / carried / quarantined and stamps the consumed trades', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // owed 80 >= 25 -> paid
    await seedTrade(sql, R2, 10); //  owed 8  <  25 -> carried
    await seedTrade(sql, R3, 100); // owed 80, but sanctioned -> quarantined
    const r = await accrue(JUN);
    expect(r.status).toBe('computed');

    const entries = await sql<{ recipient_hex: string; status: string; owed_usd: string; owed_wei: string; carried_usd: string }[]>`
      SELECT encode(recipient, 'hex') AS recipient_hex, status, owed_usd::text AS owed_usd, owed_wei::text AS owed_wei, carried_usd::text AS carried_usd
      FROM partner_fee_batch_entries ORDER BY recipient`;
    const byR = new Map(entries.map((e) => [e.recipient_hex, e]));
    expect(byR.get(R1)!.status).toBe('paid');
    expect(byR.get(R1)!.owed_wei).toBe(wei(80).toString());
    expect(parseFloat(byR.get(R1)!.carried_usd)).toBe(0);
    expect(byR.get(R2)!.status).toBe('carried');
    expect(parseFloat(byR.get(R2)!.carried_usd)).toBeCloseTo(8, 4);
    expect(byR.get(R3)!.status).toBe('quarantined');
    expect(parseFloat(byR.get(R3)!.carried_usd)).toBeCloseTo(80, 4); // rolls forward (re-attempted)

    // total_owed_wei = only the PAID entry.
    const [b] = await sql<{ total: string }[]>`SELECT total_owed_wei::text AS total FROM partner_fee_batches`;
    expect(b!.total).toBe(wei(80).toString());

    // All consumed trades stamped with the batch id (never re-summed).
    const unbatched = await sql<{ unbatched: string }[]>`SELECT COUNT(*)::text AS unbatched FROM partner_fee_trades WHERE batch_id IS NULL`;
    expect(unbatched[0]!.unbatched).toBe('0');

    // Liability = every not-paid-and-executed entry's owed_wei snapshot.
    expect(await liability()).toBe(wei(80) + wei(8) + wei(80));
  });

  it('carries a sub-threshold balance forward and pays it IN FULL once it clears', async () => {
    const sql = await getSql();
    // Cycle 1 (May): R2 earns $10 fee -> owed $8 -> carried.
    await seedTrade(sql, R2, 10);
    await accrue(JUN);
    const [c1] = await sql<{ status: string; carried_usd: string }[]>`SELECT status, carried_usd::text AS carried_usd FROM partner_fee_batch_entries WHERE recipient = decode(${R2}, 'hex')`;
    expect(c1!.status).toBe('carried');
    expect(parseFloat(c1!.carried_usd)).toBeCloseTo(8, 4);

    // Cycle 2 (June -> settles 2026-06): R2 earns $30 more -> owed 0.8*30 + 8 carried = 32 >= 25 -> paid IN FULL.
    await seedTrade(sql, R2, 30);
    await accrue(new Date('2026-07-01T02:00:00Z'));
    const [c2] = await sql<{ status: string; owed_usd: string; owed_wei: string }[]>`
      SELECT e.status, e.owed_usd::text AS owed_usd, e.owed_wei::text AS owed_wei FROM partner_fee_batch_entries e
      JOIN partner_fee_batches b ON b.id = e.batch_id WHERE e.recipient = decode(${R2}, 'hex') AND b.cycle_month = '2026-06-01'`;
    expect(c2!.status).toBe('paid');
    expect(parseFloat(c2!.owed_usd)).toBeCloseTo(32, 4);
    expect(c2!.owed_wei).toBe(wei(32).toString());
  });

  it('re-accrual before proposal is idempotent (picks up a late-priced trade, no double-count)', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // owed 80 -> paid
    const first = await accrue(JUN);
    // A late-priced trade for R1 arrives before proposal.
    await seedTrade(sql, R1, 50); // +40 owed
    const second = await accrue(JUN);
    expect(second.batchId).toBe(first.batchId); // same batch row reused
    const [e] = await sql<{ owed_usd: string; count: string }[]>`
      SELECT owed_usd::text AS owed_usd, (SELECT COUNT(*)::text FROM partner_fee_batch_entries WHERE recipient = decode(${R1}, 'hex')) AS count
      FROM partner_fee_batch_entries WHERE recipient = decode(${R1}, 'hex')`;
    expect(e!.count).toBe('1'); // exactly one entry (recomputed, not duplicated)
    expect(parseFloat(e!.owed_usd)).toBeCloseTo(120, 4); // 0.8 * (100 + 50) = 120
  });

  it('a fully-sanctioned cycle records no payable owed but still reserves the liability', async () => {
    const sql = await getSql();
    await seedTrade(sql, R3, 100);
    const r = await accrue(JUN);
    expect(r.status).toBe('computed');
    const [b] = await sql<{ total: string }[]>`SELECT total_owed_wei::text AS total FROM partner_fee_batches`;
    expect(b!.total).toBe('0'); // nothing PAID
    expect(await liability()).toBe(wei(80)); // but still owed (quarantined) -> reserved
  });
});
