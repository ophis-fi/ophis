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

// Insert a pre-existing 'computed' batch + one entry directly (simulates a back-month a
// flag-off run accrued but never proposed).
async function seedComputedBatch(cycleMonth: string, chain: number, recipient: `0x${string}`, owedWei: bigint): Promise<number> {
  const [b] = await sql`
    INSERT INTO own_fee_batches (cycle_month, chain_id, total_owed_wei, weth_usd_price, status)
    VALUES (${cycleMonth}, ${chain}, ${owedWei.toString()}, ${WETH_PRICE}, 'computed') RETURNING id`;
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
    propose: async (p: any) => {
      proposeCalls.push(p);
      await p.onBeforeSubmit?.();
      return { safeTxHash: ('0x' + 'fe'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '00'.repeat(20)) as `0x${string}`, nonce: 0 };
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

  it('rejects a non-sovereign chain (defensive)', async () => {
    const { base } = proposeDeps({ chainId: 100 });
    await expect(proposeOwnFeeBatches(base as any)).rejects.toThrow(/not sovereign/);
  });
});
