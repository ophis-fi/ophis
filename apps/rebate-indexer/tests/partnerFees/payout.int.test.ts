import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { startPg, stopPg } from '../fixtures/pgContainer.js';
import { usdFpToWei, usdToFp } from '../../src/partnerFees/split.js';

// testcontainers: partner-fee ACCRUAL + PROPOSAL money path (partner-fees Phase B) -- 80/20
// split, $25 threshold + carry-over, sanctions screening -> quarantine, trade stamping (no
// double-count), re-accrual idempotency, the outstanding liability, the symmetric proposer
// reservation, proposal-time re-screen, dry-run validation, failed-batch carry, month-end cutoff.

// Controllable proposal status for the reconcile (failed-batch carry) test. The proposer tests
// inject their own waitForExecution, so this mock only backs the reconcile's getProposalStatus.
const pollState = vi.hoisted(() => ({ status: { executed: false, isSuccessful: null as boolean | null, transactionHash: null as string | null } }));
vi.mock('../../src/batch/poll.js', () => ({
  waitForExecution: vi.fn(async () => ({ executed: false, isSuccessful: null, transactionHash: null })),
  getProposalStatus: vi.fn(async () => pollState.status),
}));

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
// settledAt defaults to mid-May 2026, before every month-end cutoff these tests use (JUN accrual
// -> cutoff June 1; the carry test's July accrual -> cutoff July 1). Pass null for an un-enriched
// (held) trade, or a post-cutoff date to exercise the month-end boundary.
async function seedTrade(sql: Awaited<ReturnType<typeof getSql>>, recipient20: string, feeUsd: number, settledAt: string | null = '2026-05-15T00:00:00Z') {
  const u = (tradeSeq++).toString(16).padStart(112, '0');
  await sql`
    INSERT INTO partner_fee_trades (trade_uid, recipient, chain_id, block_number, log_index, volume_bps, fee_token, fee_amount, fee_usd, priced_at, block_timestamp)
    VALUES (decode(${u}, 'hex'), decode(${recipient20}, 'hex'), 10, ${tradeSeq}, 0, 30, decode(${'bb'.repeat(20)}, 'hex'), 1000, ${feeUsd}, now(), ${settledAt})`;
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
  pollState.status = { executed: false, isSuccessful: null, transactionHash: null };
  vi.restoreAllMocks();
});

const JUN = new Date('2026-06-01T02:00:00Z'); // settles 2026-05

// Shared partner-fee proposer with injectable overrides (no live Safe/RPC).
async function propose(balanceWei: bigint, over: Record<string, unknown> = {}) {
  const { proposePartnerFeeBatches } = await import('../../src/partnerFees/payout.js');
  return proposePartnerFeeBatches({
    rpcUrl: 'http://rpc.test/',
    proposerPrivateKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
    proposeEnabled: true,
    readSafeWethBalanceWei: async () => balanceWei,
    getNextNonce: async () => 0,
    simulate: async () => ({ ok: true }),
    propose: async (p) => {
      await p.onBeforeSubmit?.();
      return { safeTxHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '99'.repeat(20)) as `0x${string}`, nonce: 0 };
    },
    waitForExecution: async () => ({ executed: false, isSuccessful: null, transactionHash: null }),
    ...over,
  });
}

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

describe('partner proposer symmetric reservation', () => {
  it('BLOCKS a paid batch that would leave its own carried liability unfunded', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // owed 80 -> paid 0.04 WETH
    await seedTrade(sql, R2, 10); //  owed 8  -> carried 0.004 WETH
    await accrue(JUN);
    // Safe holds 0.042 WETH: enough for the 0.04 paid ALONE, but not while reserving the 0.004
    // carried obligation. Without the symmetric reservation this would propose and strand the carry.
    const r = await propose(wei(80) + wei(2)); // 0.042 WETH (owed 80 + 2 dollars of headroom)
    expect(r.blocked).toBe(1);
    expect(r.proposed).toBe(0);
    const [b] = await sql<{ status: string }[]>`SELECT status FROM partner_fee_batches`;
    expect(b!.status).toBe('computed'); // left for a funded retry
  });

  it('proposes once the Safe covers the paid batch AND the reserved carried liability', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // paid 0.04
    await seedTrade(sql, R2, 10); //  carried 0.004
    await accrue(JUN);
    const r = await propose(wei(100)); // 0.05 WETH: covers 0.04 paid + 0.004 reserved carried
    expect(r.proposed).toBe(1);
    expect(r.blocked).toBe(0);
    const [b] = await sql<{ status: string }[]>`SELECT status FROM partner_fee_batches`;
    expect(b!.status).toBe('proposed');
  });
});

describe('P2.5 re-screen sanctions at proposal time', () => {
  it('quarantines a recipient added to the sanctions list AFTER accrual (never proposes it)', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // owed 80 -> paid at accrual (R1 not sanctioned then)
    await accrue(JUN);
    // R1 is added to the list AFTER accrual; the proposal must re-screen and quarantine it.
    const r = await propose(wei(100), { sanctions: new Set([`0x${R1}`]) });
    expect(r.proposed).toBe(0);
    const [e] = await sql<{ status: string; carried_usd: string }[]>`SELECT status, carried_usd::text AS carried_usd FROM partner_fee_batch_entries WHERE recipient = decode(${R1}, 'hex')`;
    expect(e!.status).toBe('quarantined');
    expect(parseFloat(e!.carried_usd)).toBeCloseTo(80, 4); // carried forward, re-attempted once cleared
  });
});

describe('P2.6 dry-run runs the simulator + balance check, skips only submission', () => {
  it('runs isolateBadRecipients + balance check but submits nothing and mutates nothing', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // paid 0.04
    await accrue(JUN);
    const simulateSpy = vi.fn(async () => ({ ok: true }));
    const proposeSpy = vi.fn(async (p: { onBeforeSubmit?: () => Promise<void> }) => {
      await p.onBeforeSubmit?.();
      return { safeTxHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '99'.repeat(20)) as `0x${string}`, nonce: 0 };
    });
    const r = await propose(wei(100), { proposeEnabled: false, simulate: simulateSpy, propose: proposeSpy });
    expect(r.dryRun).toBe(true);
    expect(simulateSpy).toHaveBeenCalled(); // the simulator RAN (operator validation)
    expect(proposeSpy).not.toHaveBeenCalled(); // Safe submission SKIPPED
    const [b] = await sql<{ status: string }[]>`SELECT status FROM partner_fee_batches`;
    expect(b!.status).toBe('computed'); // no DB mutation
    const [e] = await sql<{ status: string }[]>`SELECT status FROM partner_fee_batch_entries WHERE recipient = decode(${R1}, 'hex')`;
    expect(e!.status).toBe('paid'); // entries not mutated
  });

  it('dry-run REPORTS blocked when the Safe cannot cover the payout (balance check runs)', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // owed 0.04 WETH
    await accrue(JUN);
    const r = await propose(wei(1), { proposeEnabled: false }); // 0.0005 WETH < 0.04
    expect(r.dryRun).toBe(true);
    expect(r.blocked).toBe(1);
  });
});

describe('P2.7 failed-batch carry-forward', () => {
  it('a FAILED (reverted) batch carries its paid entries forward for retry, not stranded', async () => {
    const sql = await getSql();
    await seedTrade(sql, R1, 100); // paid 0.04
    await accrue(JUN);
    await propose(wei(100)); // -> 'proposed' with a persisted hash and R1 'paid'
    // Reconcile sees the Safe execution FAILED (reverted): the atomic MultiSend moved no funds.
    pollState.status = { executed: true, isSuccessful: false, transactionHash: '0x' + 'ff'.repeat(32) };
    const { reconcilePartnerFeeBatches } = await import('../../src/partnerFees/payout.js');
    const rec = await reconcilePartnerFeeBatches({});
    expect(rec.advancedFailed).toBe(1);
    const [b] = await sql<{ status: string }[]>`SELECT status FROM partner_fee_batches`;
    expect(b!.status).toBe('failed');
    // R1's paid entry is now CARRIED (not stranded 'paid'), so next cycle re-attempts it.
    const [e] = await sql<{ status: string; carried_usd: string }[]>`SELECT status, carried_usd::text AS carried_usd FROM partner_fee_batch_entries WHERE recipient = decode(${R1}, 'hex')`;
    expect(e!.status).toBe('carried');
    expect(parseFloat(e!.carried_usd)).toBeCloseTo(80, 4);
    // And it is still counted in the outstanding liability (via the carried rollup), not lost.
    expect(await liability()).toBe(wei(80));
  });
});

describe('P2.8 month-end cutoff', () => {
  it('excludes post-cutoff and null-timestamp trades from the prior month; holds them for later', async () => {
    const sql = await getSql();
    const R4 = '44'.repeat(20);
    await seedTrade(sql, R1, 100, '2026-05-20T00:00:00Z'); // May -> accrued (owed 80 -> paid)
    await seedTrade(sql, R2, 100, '2026-06-01T01:00:00Z'); // 1st 01:00 (NEW month, >= cutoff) -> excluded
    await seedTrade(sql, R4, 100, null); // un-enriched timestamp -> HELD
    await accrue(JUN); // monthEnd = 2026-06-01
    const rows = await sql<{ r: string }[]>`SELECT encode(recipient, 'hex') AS r FROM partner_fee_batch_entries`;
    const set = new Set(rows.map((x) => x.r));
    expect(set.has(R1)).toBe(true); // within the settled month
    expect(set.has(R2)).toBe(false); // pre-drain new-month trade NOT stamped to the prior month
    expect(set.has(R4)).toBe(false); // null-timestamp held out
    // The excluded trades stay UNBATCHED (batch_id NULL) for a later cycle.
    const unbatched = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM partner_fee_trades WHERE batch_id IS NULL`;
    expect(unbatched[0]!.n).toBe('2');
  });
});

describe('P2.9 getPartnerFeeStats.pendingOwedUsd', () => {
  it('includes accrued-but-unexecuted + carried + unbatched share (not ~0 after accrual)', async () => {
    const sql = await getSql();
    const { getPartnerFeeStats } = await import('../../src/partnerFees/report.js');
    await seedTrade(sql, R1, 100); // owed 80 -> paid in a 'computed' (unexecuted) batch
    await accrue(JUN); // stamps R1's trade (batch_id set)
    await seedTrade(sql, R2, 50); // fresh unbatched trade -> 80% of $50 = $40 pending
    const stats = await getPartnerFeeStats();
    // OLD code counted only the unbatched $40 (the accrued $80 was stamped/hidden). New code adds
    // the in-flight paid $80 -> $120 total.
    expect(stats.pendingOwedUsd).toBeCloseTo(120, 2);
    expect(stats.partners).toBe(2);
  });
});
