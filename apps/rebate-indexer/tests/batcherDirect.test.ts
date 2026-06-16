import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../src/db/migrate.js';
import { startPg, stopPg } from './fixtures/pgContainer.js';

// DIRECT-mode (REBATE_DIRECT_MODE) accrual-basis lifecycle, end-to-end against a
// real Postgres. All of the batcher's external calls are HTTP — the WETH balance
// read and the dry-run transfer simulation are JSON-RPC eth_call (mocked via msw
// below, dispatched by 4-byte selector); the Safe SDK (propose) + the execution
// poll + the stranded-token probe are vi.mock'd so the propose path runs without a
// live Safe. We assert the returned `poolWei` (== `distributable` on EVERY path,
// including no_recipients) and the persisted `fee_basis_weth_wei`, which together
// pin down the basis read, the pending-payout guard, the OWED-not-PAID basis on
// quarantine, and the REBATE_FEE_BASIS_WEI=0 rejection. (Codex P2 + sharp-edges
// CRITICAL-1/2, HIGH-1/2)

const RPC = 'http://rpc.test/';
const WETH = '6a023ccd1ff6f2045c3309768ead9e68f978f6e1'; // WETH_GNOSIS, lowercased, no 0x
const ONE = 10n ** 18n; // 1 WETH in wei

// Mutable per-test RPC state.
let mockBalanceWei = 0n;
const badRecipients = new Set<string>(); // lowercased 20-byte hex (no 0x): transfer reverts -> quarantine

const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');

vi.mock('../src/safe/balances.js', () => ({
  // No stranded non-WETH tokens — keeps step 1b from hitting the RPC.
  getNonWethTokenBalances: vi.fn(async () => []),
}));
vi.mock('../src/batch/propose.js', () => ({
  // Run the real onBeforeSubmit (flips the row to 'proposing') then return a fake
  // hash, exactly like a successful Safe-service submit — no real Safe SDK / RPC.
  proposeRebateBatch: vi.fn(async (p: { onBeforeSubmit?: () => Promise<void> }) => {
    await p.onBeforeSubmit?.();
    return { safeTxHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '99'.repeat(20)) as `0x${string}` };
  }),
}));
// Controllable proposal status for the reconcile test (getProposalStatus); the batcher
// tests don't use it. Hoisted so the vi.mock factory can close over it.
const pollState = vi.hoisted(() => ({
  status: { executed: false, isSuccessful: null as boolean | null, transactionHash: null as string | null },
}));
vi.mock('../src/batch/poll.js', () => ({
  // Fire-and-forget tail: resolve "not yet executed" so it never touches the row.
  waitForExecution: vi.fn(async () => ({ executed: false, isSuccessful: null, transactionHash: null })),
  getProposalStatus: vi.fn(async () => pollState.status),
}));

const server = setupServer(
  http.post(RPC, async ({ request }) => {
    const body = (await request.json()) as { id: number; method: string; params: { data: string }[] };
    const { id, method } = body;
    if (method === 'eth_chainId') return HttpResponse.json({ jsonrpc: '2.0', id, result: '0x64' });
    if (method === 'eth_call') {
      const data = body.params[0]!.data;
      const selector = data.slice(0, 10);
      if (selector === '0x70a08231') return HttpResponse.json({ jsonrpc: '2.0', id, result: hex32(mockBalanceWei) }); // balanceOf
      if (selector === '0xa9059cbb') {
        // transfer(address,uint256): recipient = last 40 hex of the first 32-byte word.
        const to = data.slice(34, 74).toLowerCase();
        if (badRecipients.has(to)) return HttpResponse.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } });
        return HttpResponse.json({ jsonrpc: '2.0', id, result: hex32(1n) }); // bool true
      }
    }
    return HttpResponse.json({ jsonrpc: '2.0', id, result: '0x' });
  }),
);

let pg: StartedPostgreSqlContainer;
type Sql = Awaited<ReturnType<typeof getSql>>;
async function getSql() {
  return (await import('../src/db/index.js')).sql;
}
async function runBatcher(now: Date) {
  const { runBatcher: rb } = await import('../src/batcher.js');
  return rb(
    { chainId: 100, rpcUrl: RPC, proposerPrivateKey: ('0x' + '11'.repeat(32)) as `0x${string}`, proposeEnabled: true, directMode: true },
    now,
  );
}

const JUN = new Date('2026-06-01T02:00:00Z');
const MAY = '2026-05-01';
const APR = '2026-04-01';

let uidCounter = 0;
async function seedWallet(sql: Sql, addr20: string, volumeUsd: number) {
  const uid = (uidCounter++).toString(16).padStart(112, '0'); // 56-byte trade_uid
  await sql`INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
    VALUES (decode(${uid}, 'hex'), 100, decode(${addr20}, 'hex'), 1, now(), decode(${WETH}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis', ${volumeUsd}, now())`;
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
}
// Seed a prior cycle row directly (status + optional basis + optional pool) to drive
// the basis read and the pool-payout-since detection. A POOL row = (basisWei=null,
// poolWei>0); a DIRECT row = (basisWei set).
async function seedBatch(sql: Sql, month: string, status: string, basisWei: bigint | null, poolWei: bigint = 0n) {
  await sql`INSERT INTO rebate_batches (cycle_month, net_fee_weth_wei, pool_weth_wei, status, fee_basis_weth_wei)
    VALUES (${month}, 0, ${poolWei.toString()}, ${status}, ${basisWei === null ? null : basisWei.toString()})`;
}

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  server.listen();
  await runMigrations();
  const sql = await getSql();
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets'); // populate (WITH NO DATA initially)
}, 60_000);

afterAll(async () => {
  server.close();
  await stopPg(pg);
});

beforeEach(async () => {
  const sql = await getSql();
  await sql`TRUNCATE rebate_batch_entries, rebate_batches, trades`;
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets'); // empty the matview
  mockBalanceWei = 0n;
  badRecipients.clear();
  delete process.env.REBATE_FEE_BASIS_WEI;
  pollState.status = { executed: false, isSuccessful: null, transactionHash: null };
});

describe('direct-mode accrual basis', () => {
  it('first cycle (no seed) rebates nothing and sets the baseline to the current balance', async () => {
    mockBalanceWei = 10n * ONE; // no prior accounted cycle, no env seed -> basis defaults to balance
    const r = await runBatcher(JUN);
    expect(r.status).toBe('no_recipients');
    expect(r.poolWei).toBe(0n); // distributable = balance - balance = 0 (rebate nothing)
    const sql = await getSql();
    const [row] = await sql<{ b: string }[]>`SELECT fee_basis_weth_wei::text AS b FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    expect(BigInt(row!.b)).toBe(10n * ONE); // baseline recorded = full balance
  });

  it('REBATE_FEE_BASIS_WEI=0 is REJECTED (does not rebate the entire balance)', async () => {
    process.env.REBATE_FEE_BASIS_WEI = '0';
    mockBalanceWei = 10n * ONE;
    const r = await runBatcher(JUN);
    expect(r.poolWei).toBe(0n); // 0 ignored -> basis defaults to balance -> distributable 0 (NOT 10 WETH)
  });

  it('REBATE_FEE_BASIS_WEI seeds a below-balance basis (rebates the historical delta)', async () => {
    process.env.REBATE_FEE_BASIS_WEI = (7n * ONE).toString();
    mockBalanceWei = 10n * ONE; // no wallets -> no_recipients, but distributable reflects the seed
    const r = await runBatcher(JUN);
    expect(r.poolWei).toBe(3n * ONE); // distributable = 10 - 7
  });

  it('basis read uses the latest ACCOUNTED cycle and skips a failed row’s stale basis (HIGH-1)', async () => {
    const sql = await getSql();
    await seedBatch(sql, APR, 'executed', 4n * ONE); // accounted
    await seedBatch(sql, MAY, 'failed', 9n * ONE); // stale optimistic basis — MUST be skipped
    mockBalanceWei = 10n * ONE;
    const r = await runBatcher(JUN);
    expect(r.poolWei).toBe(6n * ONE); // 10 - 4 (April executed), NOT 10 - 9 (May failed)
  });

  it('pending-payout guard DEFERS a new cycle while a prior payout is proposed (CRITICAL-1)', async () => {
    const sql = await getSql();
    await seedBatch(sql, MAY, 'proposed', 9n * ONE); // a prior month still awaiting signature
    mockBalanceWei = 10n * ONE;
    const r = await runBatcher(JUN);
    expect(r.status).toBe('computing'); // deferred, not proposed
    expect(r.poolWei).toBe(0n);
    const [jun] = await sql<{ status: string }[]>`SELECT status FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    expect(jun!.status).toBe('computing'); // left resumable, no second payout queued
  });

  it('normal propose cycle records basis = balance - OWED (single gold wallet)', async () => {
    const sql = await getSql();
    await seedBatch(sql, MAY, 'executed', 9n * ONE); // prior basis 9 WETH
    await seedWallet(sql, 'aa'.repeat(20), 100_000); // gold (25%)
    mockBalanceWei = 10n * ONE; // distributable = 10 - 9 = 1 WETH; sole wallet -> fee_share = 1 WETH
    const r = await runBatcher(JUN);
    expect(r.status).toBe('proposed');
    expect(r.recipientCount).toBe(1);
    expect(r.poolWei).toBe(1n * ONE);
    const [row] = await sql<{ b: string }[]>`SELECT fee_basis_weth_wei::text AS b FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    // owed = 25% of 1 WETH = 0.25; basis = 10 - 0.25 = 9.75 WETH
    expect(BigInt(row!.b)).toBe(10n * ONE - ONE / 4n);
    const [entry] = await sql<{ a: string }[]>`SELECT weth_amount_wei::text AS a FROM rebate_batch_entries`;
    expect(BigInt(entry!.a)).toBe(ONE / 4n);
  });

  it('quarantined recipient: unpaid rebate stays in the Safe, NOT redistributed (P2-4)', async () => {
    const sql = await getSql();
    await seedBatch(sql, MAY, 'executed', 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000); // gold
    await seedWallet(sql, 'bb'.repeat(20), 100_000); // gold, equal volume
    badRecipients.add('bb'.repeat(20)); // B's transfer reverts at dry-run -> quarantined
    mockBalanceWei = 10n * ONE; // distributable 1 WETH; each fee_share 0.5; each rebate 0.125
    const r = await runBatcher(JUN);
    expect(r.status).toBe('proposed');
    expect(r.recipientCount).toBe(1); // only A is paid
    const [row] = await sql<{ b: string }[]>`SELECT fee_basis_weth_wei::text AS b FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    // basis = balance - PAID = 10 - 0.125 = 9.875 (the true post-payout balance). B's owed
    // 0.125 stays in the Safe BELOW the basis -> NOT redistributed to A next cycle. (P2-4)
    expect(BigInt(row!.b)).toBe(10n * ONE - ONE / 8n);
  });

  it('full lifecycle: cycle N+1 rebates ONLY the fees that arrived after cycle N executed', async () => {
    const sql = await getSql();
    // Cycle N (May): prior basis 9, balance 10, one gold wallet -> propose, basis = 9.75.
    await seedBatch(sql, APR, 'executed', 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    mockBalanceWei = 10n * ONE;
    const n = await runBatcher(new Date('2026-05-01T02:00:00Z'));
    expect(n.status).toBe('proposed');
    const expectedBasis = 10n * ONE - ONE / 4n; // 9.75
    // Simulate the human signing + on-chain execution of cycle N's payout.
    await sql`UPDATE rebate_batches SET status = 'executed' WHERE cycle_month = ${MAY}`;
    // Cycle N+1 (June): only 0.25 WETH of new fees arrived since (balance back to 10).
    mockBalanceWei = expectedBasis + ONE / 4n; // 9.75 + 0.25 = 10
    const n1 = await runBatcher(JUN);
    expect(n1.poolWei).toBe(ONE / 4n); // distributable = 10 - 9.75 = 0.25, NOT the whole balance
  });

  it('rejects a malformed REBATE_FEE_BASIS_WEI instead of silently ignoring it (P2-1)', async () => {
    process.env.REBATE_FEE_BASIS_WEI = '1.5e18'; // non-decimal typo: must THROW, not be treated as unset
    mockBalanceWei = 10n * ONE;
    await expect(runBatcher(JUN)).rejects.toThrow(/malformed/i);
  });

  it('persists the direct distributable into pool_weth_wei, not the stale pool-split (P2-2)', async () => {
    const sql = await getSql();
    await seedBatch(sql, MAY, 'executed', 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000); // gold
    mockBalanceWei = 10n * ONE; // distributable = 10 - 9 = 1 WETH (pool-split-of-balance would be 2.125)
    const r = await runBatcher(JUN);
    expect(r.status).toBe('proposed');
    const [row] = await sql<{ p: string }[]>`SELECT pool_weth_wei::text AS p FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    expect(BigInt(row!.p)).toBe(1n * ONE);
  });

  it('re-baselines when a POOL payout executed since the last direct basis (P2-3)', async () => {
    const sql = await getSql();
    await seedBatch(sql, '2026-03-01', 'executed', 10n * ONE); // direct basis 10 (earlier id)
    await seedBatch(sql, APR, 'executed', null, 6n * ONE); // POOL payout since (NULL basis, pool>0, later id)
    await seedWallet(sql, 'aa'.repeat(20), 100_000); // gold: WITHOUT the fix this cycle PROPOSES
    // Balance recovered to 11 (ABOVE the stale basis 10). WITHOUT the fix: distributable
    // = 11-10 = 1 -> A earns a rebate -> status 'proposed', poolWei 1 (silent under-rebate of
    // the gap). WITH the fix: a POOL payout since the basis -> re-baseline to 11 -> 0 -> none.
    mockBalanceWei = 11n * ONE;
    const r = await runBatcher(JUN);
    expect(r.status).toBe('no_recipients'); // WITHOUT the fix this would be 'proposed'
    expect(r.poolWei).toBe(0n); // WITHOUT the fix this would be 1 WETH
    const [row] = await sql<{ b: string }[]>`SELECT fee_basis_weth_wei::text AS b FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    expect(BigInt(row!.b)).toBe(11n * ONE); // fresh baseline = current balance
  });

  it('alerts + re-baselines on a balance drop below the basis (withdrawal arm) (P2-3)', async () => {
    const sql = await getSql();
    const { alerts } = await import('../src/telegram/alerter.js');
    await seedBatch(sql, MAY, 'executed', 10n * ONE); // direct basis 10, NO pool row
    mockBalanceWei = 8n * ONE; // balance fell below the basis (a manual withdrawal)
    const spy = vi.spyOn(alerts, 'alert').mockResolvedValue(undefined as never);
    const r = await runBatcher(JUN);
    expect(r.status).toBe('no_recipients');
    const [row] = await sql<{ b: string }[]>`SELECT fee_basis_weth_wei::text AS b FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    expect(BigInt(row!.b)).toBe(8n * ONE); // re-baselined to current balance
    // The withdrawal arm's observable effect is the operator alert (the DB outcome alone
    // matches no_recipients either way) — assert the re-baseline alert fired.
    expect(spy.mock.calls.some((c) => /stale|re-baselin/i.test(String(c[1])))).toBe(true);
    spy.mockRestore();
  });

  it('reconcile reports the actual PAID sum, not the (distributable) pool column (P2-2)', async () => {
    const sql = await getSql();
    const { reconcileBatches } = await import('../src/batch/reconcile.js');
    const { alerts } = await import('../src/telegram/alerter.js');
    // A proposed direct row whose pool_weth_wei = distributable (1 WETH), but only 0.25 WETH
    // is actually paid: one good entry (0.25) + one quarantined entry (zeroed).
    await sql`INSERT INTO rebate_batches (cycle_month, net_fee_weth_wei, pool_weth_wei, status, safe_proposal_hash)
      VALUES (${'2026-06-01'}, ${(10n * ONE).toString()}, ${(1n * ONE).toString()}, 'proposed', decode(${'cd'.repeat(32)}, 'hex'))`;
    const [b] = await sql<{ id: number }[]>`SELECT id FROM rebate_batches WHERE cycle_month = ${'2026-06-01'}`;
    await sql`INSERT INTO rebate_batch_entries (batch_id, wallet, volume_30d_usd, tier, rebate_pct, weth_amount_wei) VALUES
      (${b!.id}, decode(${'aa'.repeat(20)}, 'hex'), 100000, 'gold', 0.25, ${(ONE / 4n).toString()}),
      (${b!.id}, decode(${'bb'.repeat(20)}, 'hex'), 100000, 'gold', 0.25, 0)`;
    pollState.status = { executed: true, isSuccessful: true, transactionHash: '0x' + 'cd'.repeat(32) };
    const spy = vi.spyOn(alerts, 'batchExecuted').mockResolvedValue(undefined as never);
    await reconcileBatches({ chainId: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0] as { pool: string; count: number };
    expect(arg.pool).toBe('0.25000'); // Σ paid entries (0.25), NOT pool_weth_wei (1.0)
    expect(arg.count).toBe(1); // one good recipient (the zeroed entry excluded)
    spy.mockRestore();
  });

  it('quarantined amount is NOT carried into the next cycle (stays as profit) (P2-4)', async () => {
    const sql = await getSql();
    await seedBatch(sql, APR, 'executed', 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    await seedWallet(sql, 'bb'.repeat(20), 100_000);
    badRecipients.add('bb'.repeat(20));
    mockBalanceWei = 10n * ONE; // cycle N (May): A paid 0.125, B (0.125) quarantined; basis = 9.875
    const n = await runBatcher(new Date('2026-05-01T02:00:00Z'));
    expect(n.status).toBe('proposed');
    expect(n.recipientCount).toBe(1);
    await sql`UPDATE rebate_batches SET status = 'executed' WHERE cycle_month = ${MAY}`;
    // After execution A's 0.125 left; B's 0.125 stayed -> Safe = 9.875 = the recorded basis.
    // Cycle N+1: no new fees; distributable = 9.875 - 9.875 = 0. B's quarantined 0.125 is
    // BELOW the basis (kept as profit), NOT redistributed. (Had the basis been owedWei=9.75,
    // distributable would be 0.125 here and B's amount would leak to others.)
    badRecipients.clear();
    mockBalanceWei = 10n * ONE - ONE / 8n; // 9.875
    const n1 = await runBatcher(JUN);
    expect(n1.poolWei).toBe(0n);
  });
});
