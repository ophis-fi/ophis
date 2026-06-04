import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../src/db/migrate.js';

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
vi.mock('../src/batch/poll.js', () => ({
  // Fire-and-forget tail: resolve "not yet executed" so it never touches the row.
  waitForExecution: vi.fn(async () => ({ executed: false, isSuccessful: null, transactionHash: null })),
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
// Seed a prior cycle row directly (status + optional basis) to drive the basis read.
async function seedBatch(sql: Sql, month: string, status: string, basisWei: bigint | null) {
  await sql`INSERT INTO rebate_batches (cycle_month, net_fee_weth_wei, pool_weth_wei, status, fee_basis_weth_wei)
    VALUES (${month}, 0, 0, ${status}, ${basisWei === null ? null : basisWei.toString()})`;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  server.listen();
  await runMigrations();
  const sql = await getSql();
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets'); // populate (WITH NO DATA initially)
}, 60_000);

afterAll(async () => {
  server.close();
  await pg?.stop();
});

beforeEach(async () => {
  const sql = await getSql();
  await sql`TRUNCATE rebate_batch_entries, rebate_batches, trades`;
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets'); // empty the matview
  mockBalanceWei = 0n;
  badRecipients.clear();
  delete process.env.REBATE_FEE_BASIS_WEI;
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

  it('quarantined recipient is DEFERRED: basis advances by OWED, not PAID (CRITICAL-2)', async () => {
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
    // owed = 0.125 (A) + 0.125 (B) = 0.25; basis = 10 - 0.25 = 9.75 (NOT 10 - 0.125 = 9.875).
    // B's deferred 0.125 stays ABOVE the basis -> re-enters next cycle's delta, not kept as profit.
    expect(BigInt(row!.b)).toBe(10n * ONE - ONE / 4n);
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
});
