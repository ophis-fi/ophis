import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

// Integration harness (testcontainers) for the SOVEREIGN per-recipient own-fee payout.
// Exercises the real accrual SQL + ledger writes against a live Postgres with migration
// 0017 applied, injecting the Safe balance / WETH price / proposer / poller so no live
// chain or Safe service is touched (the affiliate/backfill injection style).
//
// The payout is two-phase: accrueOwnFee (always, flag-independent -> records a 'computed'
// ledger) and proposeOwnFeeBatches (gated -> proposes every un-proposed 'computed' batch,
// including back-months). These tests cover both, plus the direct accrual math.

let pg: StartedPostgreSqlContainer;
let sql: any;
let computeOwnFeeAccrual: typeof import('../../src/ownFee/accrual.js')['computeOwnFeeAccrual'];
let accrueOwnFee: typeof import('../../src/ownFee/payout.js')['accrueOwnFee'];
let proposeOwnFeeBatches: typeof import('../../src/ownFee/payout.js')['proposeOwnFeeBatches'];

const W = (h: string) => h.padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');

// Two lowercased 0x recipients: R1 allowlisted, R2 NOT.
const R1 = ('0x' + '11'.repeat(20)) as `0x${string}`;
const R2 = ('0x' + '22'.repeat(20)) as `0x${string}`;
const ALLOW = new Set<string>([R1]); // custom allowlist (the real one is empty)

const WETH_PRICE = 2500; // USD per WETH, fixed for deterministic wei math

// The settled window is the PREVIOUS calendar month; seed trades mid-window.
const now = new Date();
const inWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
const cycleLabel = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

// Seed a fee-verified, priced trade carrying a stacked integrator own-fee.
function insOwnFee(args: {
  uid: string;
  chain: number;
  recipient: `0x${string}`;
  usd: string;
  ownBps: number;
  ts?: string;
  feeVerified?: boolean;
}) {
  return sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token,
      sell_amount, buy_amount, app_code, value_usd, volume_fee_bps, fee_verified,
      own_fee_bps, own_fee_recipient, own_fee_scanned_at, priced_at)
    VALUES (
      decode(${UID(args.uid)}, 'hex'), ${args.chain}, decode(${W('a11e7')}, 'hex'), 1,
      ${args.ts ?? inWindow}, decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'),
      1, 1, 'ophis', ${args.usd}, 10, ${args.feeVerified ?? true},
      ${args.ownBps}, decode(${args.recipient.slice(2)}, 'hex'), now(), now())`;
}

// Insert a pre-existing batch + one entry directly. Default status 'computed' simulates a
// back-month a flag-off run accrued but never proposed; pass 'proposed' to simulate a
// queued-but-unsigned batch whose owed WETH is still committed in the Safe.
async function seedComputedBatch(
  cycleMonth: string,
  chain: number,
  recipient: `0x${string}`,
  owedWei: bigint,
  status = 'computed',
): Promise<number> {
  const [b] = await sql`
    INSERT INTO own_fee_batches (cycle_month, chain_id, total_owed_wei, weth_usd_price, status)
    VALUES (${cycleMonth}, ${chain}, ${owedWei.toString()}, ${WETH_PRICE}, ${status}) RETURNING id`;
  await sql`
    INSERT INTO own_fee_batch_entries (batch_id, recipient, owed_wei, status)
    VALUES (${b.id}, decode(${recipient.slice(2)}, 'hex'), ${owedWei.toString()}, 'pending')`;
  return b.id;
}

// Accrual deps: only price + allowlist injected (accrual reads no Safe / proposes nothing).
const accrueDeps = (o: Record<string, unknown> = {}) => ({ chainId: 10, allowlist: ALLOW, fetchWethUsdPrice: async () => WETH_PRICE, ...o }) as any;

// Propose deps: injectable Safe balance / proposer / poller. propose records its calls.
function proposeDeps(o: Record<string, unknown> = {}) {
  const proposeCalls: any[] = [];
  const base = {
    chainId: 10,
    rpcUrl: 'http://unused.test',
    proposerPrivateKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
    proposeEnabled: true,
    readSafeWethBalanceWei: async () => 10n ** 24n, // huge by default
    getNextNonce: async () => 0, // injected so tests never hit the real Safe service
    propose: async (p: any) => {
      proposeCalls.push(p);
      await p.onBeforeSubmit?.();
      return { safeTxHash: ('0x' + 'fe'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '00'.repeat(20)) as `0x${string}`, nonce: p.nonce ?? 0 };
    },
    waitForExecution: async () => ({ executed: false, isSuccessful: null, transactionHash: null }),
    ...o,
  };
  return { base, proposeCalls };
}

const batchRow = async (chain = 10, cycle = cycleLabel) =>
  (await sql`SELECT status, chain_id, total_owed_wei::text AS owed, encode(safe_proposal_hash, 'hex') AS hash FROM own_fee_batches WHERE cycle_month = ${cycle} AND chain_id = ${chain}`)[0];

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations(); // applies migration 0017_own_fee_batches.sql
  ({ sql } = await import('../../src/db/index.js'));
  ({ computeOwnFeeAccrual } = await import('../../src/ownFee/accrual.js'));
  ({ accrueOwnFee, proposeOwnFeeBatches } = await import('../../src/ownFee/payout.js'));
}, 180_000);

afterAll(async () => {
  await sql?.end?.();
  await stopPg(pg);
});

beforeEach(async () => {
  await sql`TRUNCATE own_fee_batch_entries, own_fee_batches, trades RESTART IDENTITY CASCADE`;
});

describe('computeOwnFeeAccrual - allowlist filter + owed_wei math', () => {
  it('does NOT accrue a non-allowlisted own-fee recipient (9a)', async () => {
    await insOwnFee({ uid: 'a1', chain: 10, recipient: R1, usd: '100000', ownBps: 20 }); // allowlisted
    await insOwnFee({ uid: 'a2', chain: 10, recipient: R2, usd: '999999', ownBps: 90 }); // NOT allowlisted
    const owed = await computeOwnFeeAccrual(10, monthStart, monthEnd, WETH_PRICE, ALLOW);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.recipient).toBe(R1);
  });

  it('computes owed_wei from value_usd * own_fee_bps at a known WETH price (9f)', async () => {
    // value_usd 100000 * own 25 bps = 2,500,000 USD*bps -> owedUsd $250. At $2500/WETH
    // owedWei = 250/2500 * 1e18 = 0.1 WETH = 1e17 wei (bigint fixed-point, no float).
    await insOwnFee({ uid: 'f1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    const owed = await computeOwnFeeAccrual(10, monthStart, monthEnd, WETH_PRICE, ALLOW);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.recipient).toBe(R1);
    expect(owed[0]!.owedUsd).toBeCloseTo(250, 6);
    expect(owed[0]!.owedWei).toBe(10n ** 17n);
  });

  it('excludes fee-unverified rows and out-of-window trades from the base', async () => {
    await insOwnFee({ uid: 'e1', chain: 10, recipient: R1, usd: '100000', ownBps: 25, feeVerified: false }); // excluded
    const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString();
    await insOwnFee({ uid: 'e2', chain: 10, recipient: R1, usd: '100000', ownBps: 25, ts: before }); // out of window
    const owed = await computeOwnFeeAccrual(10, monthStart, monthEnd, WETH_PRICE, ALLOW);
    expect(owed).toHaveLength(0);
  });
});

describe('accrueOwnFee - always records the ledger, flag-independent', () => {
  it('records a computed batch + entries with the payout flag OFF (a)', async () => {
    // No flag is consulted by accrueOwnFee; it always records the owed ledger.
    await insOwnFee({ uid: 'c1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    const res = await accrueOwnFee(accrueDeps());
    expect(res.status).toBe('computed');
    const row = await batchRow();
    expect(row.status).toBe('computed');
    expect(row.owed).toBe((10n ** 17n).toString());
    expect(row.hash).toBeNull(); // recorded, NOT proposed
    const entries = await sql`SELECT encode(recipient, 'hex') AS r, owed_wei::text AS owed, paid_wei, status FROM own_fee_batch_entries WHERE batch_id = ${res.batchId}`;
    expect(entries).toHaveLength(1);
    expect(entries[0].r).toBe('11'.repeat(20));
    expect(entries[0].owed).toBe((10n ** 17n).toString());
    expect(entries[0].paid_wei).toBeNull();
    expect(entries[0].status).toBe('pending');
  });

  it('records a no_recipients batch when nothing is allowlisted (9b)', async () => {
    await insOwnFee({ uid: 'b1', chain: 10, recipient: R2, usd: '100000', ownBps: 25 }); // R2 not allowlisted
    const res = await accrueOwnFee(accrueDeps());
    expect(res.status).toBe('no_recipients');
    const row = await batchRow();
    expect(row.status).toBe('no_recipients');
    expect(row.owed).toBe('0');
  });

  it('re-accrues a still-computed batch, updating owed for late-indexed trades (e)', async () => {
    await insOwnFee({ uid: 'ea1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 }); // owed 1e17
    const first = await accrueOwnFee(accrueDeps());
    expect(first.status).toBe('computed');
    // A late-indexed trade for the SAME window + recipient arrives before proposal.
    await insOwnFee({ uid: 'ea2', chain: 10, recipient: R1, usd: '100000', ownBps: 25 }); // +1e17
    const second = await accrueOwnFee(accrueDeps());
    expect(second.status).toBe('computed');
    expect(second.batchId).toBe(first.batchId); // same batch, updated
    const row = await batchRow();
    expect(row.owed).toBe((2n * 10n ** 17n).toString()); // owed doubled
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM own_fee_batch_entries WHERE batch_id = ${first.batchId}`;
    expect(n).toBe(1); // one recipient, entries replaced (not duplicated)
    const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM own_fee_batches WHERE cycle_month = ${cycleLabel} AND chain_id = 10`;
    expect(c).toBe(1); // never a duplicate batch
  });

  it('LOCKS a proposed batch: never re-accrues or double-pays (c, accrual side)', async () => {
    await insOwnFee({ uid: 'ca1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    const first = await accrueOwnFee(accrueDeps());
    // Simulate it having been proposed.
    await sql`UPDATE own_fee_batches SET status = 'proposed', total_owed_wei = ${(10n ** 17n).toString()} WHERE id = ${first.batchId}`;
    // Even with MORE trades indexed, a proposed batch is left untouched.
    await insOwnFee({ uid: 'ca2', chain: 10, recipient: R1, usd: '500000', ownBps: 25 });
    const again = await accrueOwnFee(accrueDeps());
    expect(again.status).toBe('locked');
    expect(again.batchId).toBe(first.batchId);
    const row = await batchRow();
    expect(row.status).toBe('proposed'); // unchanged
    expect(row.owed).toBe((10n ** 17n).toString()); // owed NOT recomputed
  });

  it('rejects a non-sovereign chain (defensive)', async () => {
    await expect(accrueOwnFee(accrueDeps({ chainId: 100 }))).rejects.toThrow(/not sovereign/);
  });

  it('first-accrual insert is ATOMIC: an entries failure rolls back the batch row (FIX 3)', async () => {
    await insOwnFee({ uid: 'af1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 }); // owed 1e17
    try {
      // Force the entries insert to fail (no owed_wei is negative) so we can prove the batch
      // insert, done in the SAME transaction, rolls back with it rather than orphaning a
      // 'computed' batch that has NO entries (which would later propose an empty transfer or
      // wedge, and never re-accrue because a row already exists).
      await sql`ALTER TABLE own_fee_batch_entries ADD CONSTRAINT own_fee_entries_force_fail CHECK (owed_wei < 0)`;
      await expect(accrueOwnFee(accrueDeps({ now }))).rejects.toThrow();
      const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM own_fee_batches WHERE cycle_month = ${cycleLabel} AND chain_id = 10`;
      expect(c).toBe(0); // atomic: NO orphan batch row left behind
    } finally {
      await sql`ALTER TABLE own_fee_batch_entries DROP CONSTRAINT IF EXISTS own_fee_entries_force_fail`;
    }
    // Fault removed: the next run re-accrues cleanly (the month was never lost).
    const res = await accrueOwnFee(accrueDeps({ now }));
    expect(res.status).toBe('computed');
    const row = await batchRow();
    expect(row.status).toBe('computed');
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM own_fee_batch_entries WHERE batch_id = ${res.batchId}`;
    expect(n).toBe(1);
  });

  it('catches up a MISSED prior settled month; never re-accrues a proposed month (FIX 5)', async () => {
    // A trade for a PRIOR settled month (month-2) that a missed/failed first-of-month run
    // never accrued. Later runs would previously skip it forever (the cron advances past it).
    const back2Ts = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15)).toISOString();
    const back2Cycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    await insOwnFee({ uid: 'cd1', chain: 10, recipient: R1, usd: '100000', ownBps: 25, ts: back2Ts }); // owed 1e17
    const [{ before }] = await sql`SELECT COUNT(*)::int AS before FROM own_fee_batches WHERE cycle_month = ${back2Cycle} AND chain_id = 10`;
    expect(before).toBe(0); // no batch yet (the run that should have made it was missed)

    await accrueOwnFee(accrueDeps({ now })); // a later run within the lookback catches it up
    const caught = await batchRow(10, back2Cycle);
    expect(caught.status).toBe('computed');
    expect(caught.owed).toBe((10n ** 17n).toString());

    // A LOCKED ('proposed') prior month is NEVER re-accrued, even with more trades indexed.
    const back3Cycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
    const propId = await seedComputedBatch(back3Cycle, 10, R1, 10n ** 17n, 'proposed');
    const back3Ts = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 15)).toISOString();
    await insOwnFee({ uid: 'cd2', chain: 10, recipient: R1, usd: '500000', ownBps: 25, ts: back3Ts }); // would be 5e17 if re-accrued
    await accrueOwnFee(accrueDeps({ now }));
    const locked = await batchRow(10, back3Cycle);
    expect(locked.status).toBe('proposed'); // untouched
    expect(locked.owed).toBe((10n ** 17n).toString()); // NOT recomputed to 5e17
    expect(propId).toBeGreaterThan(0);
  });

  it('re-accrues a back-month at its STORED price; a first-accrual month uses the fresh spot (price determinism, Codex P2)', async () => {
    const P1 = 2500; // the back-month price LOCKED at its first accrual (== WETH_PRICE)
    const P2 = 3000; // a later, DIFFERENT ETH spot for this run's fresh fetch

    // Back-month (month-2): a pre-existing UNLOCKED 'computed' row locked at P1, WITH a
    // matching trade so a re-accrual at the stored price reproduces the same owed.
    const back2Cycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    const back2Ts = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15)).toISOString();
    await insOwnFee({ uid: 'fa1', chain: 10, recipient: R1, usd: '100000', ownBps: 25, ts: back2Ts }); // owed 1e17 at P1
    await seedComputedBatch(back2Cycle, 10, R1, 10n ** 17n); // seeds weth_usd_price = WETH_PRICE = P1

    // Current settled month: a NEW trade with NO existing row -> first accrual fetches P2.
    await insOwnFee({ uid: 'fa2', chain: 10, recipient: R1, usd: '100000', ownBps: 25 }); // current window

    // Re-accrue with the spot moved to P2 and NO new trades for the back-month.
    await accrueOwnFee(accrueDeps({ now, fetchWethUsdPrice: async () => P2 }));

    // Back-month: UNCHANGED. Recomputed at the STORED P1 (not the P2 spot), so with no new
    // trades the owed stays 1e17 and the row's price stays P1 -- the owed WETH is deterministic.
    const back = await batchRow(10, back2Cycle);
    expect(back.status).toBe('computed');
    expect(back.owed).toBe((10n ** 17n).toString());
    const [{ price: backPrice }] = await sql`SELECT weth_usd_price::float8 AS price FROM own_fee_batches WHERE cycle_month = ${back2Cycle} AND chain_id = 10`;
    expect(backPrice).toBe(P1);

    // Current settled month: NEW row priced at the fresh P2. owed = $250 / $3000 * 1e18 wei.
    const cur = await batchRow();
    expect(cur.status).toBe('computed');
    const [{ price: curPrice }] = await sql`SELECT weth_usd_price::float8 AS price FROM own_fee_batches WHERE cycle_month = ${cycleLabel} AND chain_id = 10`;
    expect(curPrice).toBe(P2);
    const expectedCurOwed = (2_500_000n * 10n ** 18n) / 30_000_000n; // owedUsdFp * 1e18 / priceFp
    expect(cur.owed).toBe(expectedCurOwed.toString());

    // A NEW back-month trade DOES change the owed, but it is STILL priced at the stored P1,
    // never the P2 spot (the added volume is priced at the month's original price).
    await insOwnFee({ uid: 'fa3', chain: 10, recipient: R1, usd: '100000', ownBps: 25, ts: back2Ts }); // +$250 -> +1e17 at P1
    await accrueOwnFee(accrueDeps({ now, fetchWethUsdPrice: async () => P2 }));
    const back2 = await batchRow(10, back2Cycle);
    expect(back2.owed).toBe((2n * 10n ** 17n).toString()); // owed doubled by the new trade
    const [{ price: backPrice2 }] = await sql`SELECT weth_usd_price::float8 AS price FROM own_fee_batches WHERE cycle_month = ${back2Cycle} AND chain_id = 10`;
    expect(backPrice2).toBe(P1); // price NOT bumped to P2
  });
});

describe('proposeOwnFeeBatches - gated proposal, back-month catch-up, over-draw guard', () => {
  it('proposes a pre-accrued computed batch and marks it proposed (b)', async () => {
    await insOwnFee({ uid: 'ba1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    const acc = await accrueOwnFee(accrueDeps());
    expect(acc.status).toBe('computed');
    const { base, proposeCalls } = proposeDeps();
    const res = await proposeOwnFeeBatches(base as any);
    expect(res).toMatchObject({ checked: 1, proposed: 1, blocked: 0 });
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0].transfers).toEqual([{ to: R1, amount: 10n ** 17n }]);
    const row = await batchRow();
    expect(row.status).toBe('proposed');
    expect(row.hash).toBe('fe'.repeat(32));
  });

  it('resumes back-months: proposes every un-proposed computed batch, oldest first (b)', async () => {
    // Current cycle via accrual + an older 'computed' back-month a flag-off run left behind.
    await insOwnFee({ uid: 'fb1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    await accrueOwnFee(accrueDeps()); // current cycle, owed 1e17
    const backCycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    await seedComputedBatch(backCycle, 10, R1, 2n * 10n ** 17n); // back-month, owed 2e17
    const { base, proposeCalls } = proposeDeps();
    const res = await proposeOwnFeeBatches(base as any);
    expect(res.proposed).toBe(2); // BOTH proposed (catch-up)
    expect(proposeCalls).toHaveLength(2);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM own_fee_batches WHERE chain_id = 10 AND status = 'proposed'`;
    expect(n).toBe(2);
  });

  it('over-draw leaves the batch computed (retries), no proposal, no wedge (d)', async () => {
    await insOwnFee({ uid: 'd1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 }); // owed 1e17
    await accrueOwnFee(accrueDeps());
    const blocked = proposeDeps({ readSafeWethBalanceWei: async () => 1n }); // far below owed
    const res = await proposeOwnFeeBatches(blocked.base as any);
    expect(res).toMatchObject({ proposed: 0, blocked: 1 });
    expect(blocked.proposeCalls).toHaveLength(0); // never proposed
    expect((await batchRow()).status).toBe('computed'); // left computed, not wedged
    // Once funded, the SAME computed batch proposes on the next run (retry works).
    const funded = proposeDeps();
    const res2 = await proposeOwnFeeBatches(funded.base as any);
    expect(res2.proposed).toBe(1);
    expect((await batchRow()).status).toBe('proposed');
  });

  it('never re-proposes a proposed/executed batch (c, proposal side)', async () => {
    await insOwnFee({ uid: 'ec1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    await accrueOwnFee(accrueDeps());
    const first = proposeDeps();
    await proposeOwnFeeBatches(first.base as any); // -> proposed
    expect((await batchRow()).status).toBe('proposed');
    // A second proposal run finds NO 'computed' batches -> proposes nothing.
    const second = proposeDeps();
    const res = await proposeOwnFeeBatches(second.base as any);
    expect(res).toMatchObject({ checked: 0, proposed: 0, blocked: 0 });
    expect(second.proposeCalls).toHaveLength(0);
    // Mark it executed and confirm it is still never re-picked.
    await sql`UPDATE own_fee_batches SET status = 'executed' WHERE cycle_month = ${cycleLabel} AND chain_id = 10`;
    const third = proposeDeps();
    const res3 = await proposeOwnFeeBatches(third.base as any);
    expect(res3.proposed).toBe(0);
    expect(third.proposeCalls).toHaveLength(0);
  });

  it('dry-run (proposeEnabled false) records nothing and proposes nothing', async () => {
    await insOwnFee({ uid: 'da1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    await accrueOwnFee(accrueDeps());
    const { base, proposeCalls } = proposeDeps({ proposeEnabled: false });
    const res = await proposeOwnFeeBatches(base as any);
    expect(res.dryRun).toBe(true);
    expect(proposeCalls).toHaveLength(0);
    expect((await batchRow()).status).toBe('computed'); // untouched
  });

  it('RESERVES WETH already committed to a queued (proposed) batch, blocking an over-draw (FIX 2)', async () => {
    // A prior 'proposed' back-month batch still holds its 8e17 owed WETH in the Safe.
    const backCycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    await seedComputedBatch(backCycle, 10, R1, 8n * 10n ** 17n, 'proposed');
    // A new computed batch owing 5e17 for the current cycle.
    await insOwnFee({ uid: 'be1', chain: 10, recipient: R1, usd: '500000', ownBps: 25 }); // owed 5e17
    await accrueOwnFee(accrueDeps({ now }));

    // Raw Safe balance is 1e18 -- which ALONE fits the new 5e17 batch. But 8e17 is reserved
    // for the queued 'proposed' batch, so only 2e17 is truly available and the new batch
    // (5e17 > 2e17) must be BLOCKED, not proposed against already-committed funds.
    const balanceOneEth = { readSafeWethBalanceWei: async () => 10n ** 18n };
    const blocked = proposeDeps(balanceOneEth);
    const res = await proposeOwnFeeBatches(blocked.base as any);
    expect(res).toMatchObject({ proposed: 0, blocked: 1 });
    expect(blocked.proposeCalls).toHaveLength(0); // never proposed
    expect((await batchRow()).status).toBe('computed'); // left computed, retries next run

    // Control: once the queued batch is executed (no longer reserving WETH), the SAME 1e18
    // balance now clears the 5e17 batch -- proving the reserve, not the raw balance, blocked it.
    await sql`UPDATE own_fee_batches SET status = 'executed' WHERE cycle_month = ${backCycle} AND chain_id = 10`;
    const funded = proposeDeps(balanceOneEth);
    const res2 = await proposeOwnFeeBatches(funded.base as any);
    expect(res2.proposed).toBe(1);
    expect((await batchRow()).status).toBe('proposed');
  });

  it('reads getNextNonce ONCE and gives the two catch-up proposals nonces N then N+1 (FIX 4)', async () => {
    // Two computed batches proposed in one run: current cycle (via accrual) + an older one.
    await insOwnFee({ uid: 'ac1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    await accrueOwnFee(accrueDeps({ now })); // current cycle, owed 1e17
    const backCycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    await seedComputedBatch(backCycle, 10, R1, 10n ** 17n); // back-month, owed 1e17

    // The CALLER owns the nonce: it reads getNextNonce ONCE and derives each subsequent
    // proposal locally (+1). Assert it is consulted exactly once and each proposal carries an
    // EXPLICIT nonce (no re-read between them, which could race the Tx Service and collide).
    const N = 5;
    let getNextNonceCalls = 0;
    const getNextNonce = async () => { getNextNonceCalls++; return N; };
    const nonceCalls: any[] = [];
    const propose = async (p: any) => {
      nonceCalls.push(p);
      await p.onBeforeSubmit?.();
      return { safeTxHash: ('0x' + 'fe'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '00'.repeat(20)) as `0x${string}`, nonce: p.nonce };
    };
    const { base } = proposeDeps({ getNextNonce, propose });
    const res = await proposeOwnFeeBatches(base as any);
    expect(res.proposed).toBe(2);
    expect(getNextNonceCalls).toBe(1); // read ONCE for the whole run
    expect(nonceCalls).toHaveLength(2);
    expect(nonceCalls[0].nonce).toBe(N);     // first proposal at N (explicit)
    expect(nonceCalls[1].nonce).toBe(N + 1); // second derived locally, NO re-read
  });

  it('advances the nonce even when the FIRST proposal fails AFTER send (attempted); getNextNonce still read once (FIX 4)', async () => {
    // Two computed batches; the OLDER (proposed first) fails AFTER send -> 'attempted', where
    // the old previousNonce-based logic would leave the pin undefined and re-read for batch 2.
    await insOwnFee({ uid: 'ad1', chain: 10, recipient: R1, usd: '100000', ownBps: 25 });
    await accrueOwnFee(accrueDeps({ now })); // current cycle, owed 1e17
    const backCycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    await seedComputedBatch(backCycle, 10, R1, 10n ** 17n); // back-month, proposed FIRST (oldest)

    const N = 9;
    let getNextNonceCalls = 0;
    const getNextNonce = async () => { getNextNonceCalls++; return N; };
    const nonceCalls: any[] = [];
    let call = 0;
    const propose = async (p: any) => {
      nonceCalls.push(p);
      call++;
      // Mark 'proposing' (submitAttempted) THEN throw on the first -> proposeComputedBatch
      // returns 'attempted' (a proposal MAY be queued at nonce N).
      await p.onBeforeSubmit?.();
      if (call === 1) throw new Error('safe service dropped after send');
      return { safeTxHash: ('0x' + 'fe'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '00'.repeat(20)) as `0x${string}`, nonce: p.nonce };
    };
    const { base } = proposeDeps({ getNextNonce, propose });
    const res = await proposeOwnFeeBatches(base as any);
    // The failed first batch is not a clean propose, but the SECOND still receives N+1.
    expect(res.proposed).toBe(1);
    expect(getNextNonceCalls).toBe(1); // still read ONCE
    expect(nonceCalls).toHaveLength(2);
    expect(nonceCalls[0].nonce).toBe(N);     // attempted, consumed N
    expect(nonceCalls[1].nonce).toBe(N + 1); // offset advanced despite the failure
  });

  it('never reads getNextNonce when EVERY payable batch is BLOCKED (lazy nonce, Codex P2)', async () => {
    // Two computed batches, both owing far more than the Safe holds -> both over-draw BLOCKED.
    // The nonce read (which contacts the Safe Tx Service) must be LAZY: it fires only when a
    // batch is actually proposed. With nothing proposed, an underfunded run must reach the end,
    // return blocked>0 proposed=0 with its alerts, and NEVER call getNextNonce (so a Tx Service
    // outage cannot make an underfunded run throw on a nonce it would never use).
    await insOwnFee({ uid: 'ba9', chain: 10, recipient: R1, usd: '100000', ownBps: 25 }); // owed 1e17
    await accrueOwnFee(accrueDeps());
    const backCycle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    await seedComputedBatch(backCycle, 10, R1, 2n * 10n ** 17n); // back-month, owed 2e17

    let getNextNonceCalls = 0;
    const getNextNonce = async () => { getNextNonceCalls++; return 0; };
    // 1 wei Safe balance: below either owed, so planOwnFeePayout BLOCKS both batches.
    const blocked = proposeDeps({ readSafeWethBalanceWei: async () => 1n, getNextNonce });
    const res = await proposeOwnFeeBatches(blocked.base as any);
    expect(res).toMatchObject({ checked: 2, proposed: 0, blocked: 2 });
    expect(getNextNonceCalls).toBe(0); // NEVER read: no batch was actually proposed
    expect(blocked.proposeCalls).toHaveLength(0);
    // Both left 'computed' to retry once the Safe is funded (no wedge).
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM own_fee_batches WHERE chain_id = 10 AND status = 'computed'`;
    expect(n).toBe(2);
  });

  it('rejects a non-sovereign chain (defensive)', async () => {
    const { base } = proposeDeps({ chainId: 100 });
    await expect(proposeOwnFeeBatches(base as any)).rejects.toThrow(/not sovereign/);
  });
});
