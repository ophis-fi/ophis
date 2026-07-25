import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../../src/db/migrate.js';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

// MONEY-CORRECTNESS integration test (partner-fees Phase B, reopens audit C3/F6): proves the
// outstanding partner liability is SUBTRACTED from the rebate DIRECT-mode distributable and
// therefore CANNOT be double-paid across the partner and rebate batchers. Runs the REAL
// direct-mode rebate batcher against a real Postgres, with the Safe balance + dry-run mocked
// via msw exactly like tests/batcherDirect.test.ts. The partner batch is seeded directly.

const RPC = 'http://rpc.test/';
const WETH = '6a023ccd1ff6f2045c3309768ead9e68f978f6e1'; // WETH_GNOSIS, lowercased, no 0x
const ONE = 10n ** 18n;
const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');

let mockBalanceWei = 0n;

vi.mock('../../src/safe/balances.js', () => ({ getNonWethTokenBalances: vi.fn(async () => []) }));
vi.mock('../../src/batch/propose.js', () => ({
  proposeRebateBatch: vi.fn(async (p: { onBeforeSubmit?: () => Promise<void> }) => {
    await p.onBeforeSubmit?.();
    return { safeTxHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`, proposerAddress: ('0x' + '99'.repeat(20)) as `0x${string}` };
  }),
}));
vi.mock('../../src/batch/poll.js', () => ({
  waitForExecution: vi.fn(async () => ({ executed: false, isSuccessful: null, transactionHash: null })),
  getProposalStatus: vi.fn(async () => ({ executed: false, isSuccessful: null, transactionHash: null })),
}));

const server = setupServer(
  http.post(RPC, async ({ request }) => {
    const body = (await request.json()) as { id: number; method: string; params: { data: string }[] };
    const { id, method } = body;
    if (method === 'eth_chainId') return HttpResponse.json({ jsonrpc: '2.0', id, result: '0x64' });
    if (method === 'eth_call') {
      const selector = body.params[0]!.data.slice(0, 10);
      if (selector === '0x70a08231') return HttpResponse.json({ jsonrpc: '2.0', id, result: hex32(mockBalanceWei) });
      if (selector === '0xa9059cbb') return HttpResponse.json({ jsonrpc: '2.0', id, result: hex32(1n) });
    }
    return HttpResponse.json({ jsonrpc: '2.0', id, result: '0x' });
  }),
);

let pg: StartedPostgreSqlContainer;
async function getSql() {
  return (await import('../../src/db/index.js')).sql;
}
async function runBatcher(now: Date) {
  const { runBatcher: rb } = await import('../../src/batcher.js');
  return rb({ chainId: 100, rpcUrl: RPC, proposerPrivateKey: ('0x' + '11'.repeat(32)) as `0x${string}`, proposeEnabled: true, directMode: true }, now);
}
async function liability() {
  const { outstandingPartnerLiabilityWei } = await import('../../src/partnerFees/liability.js');
  return outstandingPartnerLiabilityWei();
}

const JUN = new Date('2026-06-01T02:00:00Z');
const MAY = '2026-05-01';

let uid = 0;
async function seedWallet(sql: Awaited<ReturnType<typeof getSql>>, addr20: string, volumeUsd: number) {
  const u = (uid++).toString(16).padStart(112, '0');
  await sql`INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
    VALUES (decode(${u}, 'hex'), 100, decode(${addr20}, 'hex'), 1, now(), decode(${WETH}, 'hex'), decode(${'22'.repeat(20)}, 'hex'), 1, 1, 'ophis', ${volumeUsd}, now())`;
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
}
async function seedRebateBasis(sql: Awaited<ReturnType<typeof getSql>>, month: string, basisWei: bigint) {
  await sql`INSERT INTO rebate_batches (cycle_month, net_fee_weth_wei, pool_weth_wei, status, fee_basis_weth_wei)
    VALUES (${month}, 0, 0, 'executed', ${basisWei.toString()})`;
}
// Seed a partner batch + one entry directly (the accrual output). status: partner batch status,
// entryStatus: paid/carried/quarantined.
async function seedPartnerLiability(
  sql: Awaited<ReturnType<typeof getSql>>,
  cycleMonth: string,
  batchStatus: string,
  recipient20: string,
  owedWei: bigint,
  entryStatus: string,
  carriedUsd = 0,
) {
  const [b] = await sql<{ id: number }[]>`
    INSERT INTO partner_fee_batches (cycle_month, total_owed_wei, status)
    VALUES (${cycleMonth}, ${owedWei.toString()}, ${batchStatus}) RETURNING id`;
  await sql`
    INSERT INTO partner_fee_batch_entries (batch_id, recipient, owed_usd, owed_wei, carried_usd, status)
    VALUES (${b!.id}, decode(${recipient20}, 'hex'), 100, ${owedWei.toString()}, ${carriedUsd}, ${entryStatus})`;
  return b!.id;
}

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  process.env.REBATE_DIRECT_MODE = 'true';
  server.listen();
  await runMigrations();
  const sql = await getSql();
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
}, 120_000);

afterAll(async () => {
  server.close();
  await stopPg(pg);
});

beforeEach(async () => {
  const sql = await getSql();
  await sql`TRUNCATE partner_fee_batch_entries, partner_fee_batches, partner_fee_trades, rebate_batch_entries, rebate_batches, trades RESTART IDENTITY CASCADE`;
  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
  mockBalanceWei = 0n;
});

describe('partner liability subtracted from the rebate DIRECT distributable', () => {
  it('baseline with NO partner liability rebates the full new-fees delta', async () => {
    const sql = await getSql();
    await seedRebateBasis(sql, MAY, 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000); // gold 25%
    mockBalanceWei = 10n * ONE; // newFees = 10 - 9 = 1 WETH
    const r = await runBatcher(JUN);
    expect(r.status).toBe('proposed');
    expect(r.poolWei).toBe(1n * ONE); // full delta distributable (no partner reserve)
    const [entry] = await sql<{ a: string }[]>`SELECT weth_amount_wei::text AS a FROM rebate_batch_entries`;
    expect(BigInt(entry!.a)).toBe(ONE / 4n); // 25% of 1 WETH
  });

  it('SUBTRACTS the outstanding partner liability from the distributable (no double-pay)', async () => {
    const sql = await getSql();
    await seedRebateBasis(sql, MAY, 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    // 0.5 WETH owed to a partner, PROPOSED (queued, not executed) -> still in the Safe.
    await seedPartnerLiability(sql, MAY, 'proposed', 'cc'.repeat(20), ONE / 2n, 'paid');
    expect(await liability()).toBe(ONE / 2n);
    mockBalanceWei = 10n * ONE; // newFees delta = 1 WETH, but 0.5 is partner-owed
    const r = await runBatcher(JUN);
    // distributable = (10 - 9) - 0.5 = 0.5 WETH; the partner-owed 0.5 is NEVER in the pool.
    expect(r.poolWei).toBe(ONE / 2n);
    const [entry] = await sql<{ a: string }[]>`SELECT weth_amount_wei::text AS a FROM rebate_batch_entries`;
    expect(BigInt(entry!.a)).toBe(ONE / 8n); // 25% of 0.5 WETH
    // Double-spend proof: rebate paid (0.125) + partner owed (0.5) <= new-fees delta (1.0).
    expect(BigInt(entry!.a) + ONE / 2n).toBeLessThanOrEqual(1n * ONE);
  });

  it('a CARRIED partner entry is also reserved (its owed_wei snapshot)', async () => {
    const sql = await getSql();
    await seedRebateBasis(sql, MAY, 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    // A sub-threshold carried entry: batch executed, but the entry never paid -> still owed.
    await seedPartnerLiability(sql, MAY, 'executed', 'cc'.repeat(20), ONE / 4n, 'carried', 20);
    expect(await liability()).toBe(ONE / 4n); // carried entry in an executed batch is still a liability
    mockBalanceWei = 10n * ONE;
    const r = await runBatcher(JUN);
    expect(r.poolWei).toBe(ONE - ONE / 4n); // 1 - 0.25 = 0.75 WETH
  });

  it('a PAID + EXECUTED partner entry is DISCHARGED (0 liability, full distributable restored)', async () => {
    const sql = await getSql();
    await seedRebateBasis(sql, MAY, 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    // The partner was already paid on-chain (executed): the WETH left the Safe -> not a liability.
    await seedPartnerLiability(sql, MAY, 'executed', 'cc'.repeat(20), ONE / 2n, 'paid');
    expect(await liability()).toBe(0n);
    mockBalanceWei = 10n * ONE;
    const r = await runBatcher(JUN);
    expect(r.poolWei).toBe(1n * ONE); // nothing reserved -> full delta
  });

  it('the CARRIED rollup takes only the LATEST entry per recipient (running carry never double-counts)', async () => {
    const sql = await getSql();
    // Cycle 1: carried 0.3 (consumed into cycle 2). Cycle 2 (later): the same recipient paid 0.5.
    await seedPartnerLiability(sql, '2026-04-01', 'executed', 'cc'.repeat(20), (ONE * 3n) / 10n, 'carried', 15);
    await seedPartnerLiability(sql, MAY, 'proposed', 'cc'.repeat(20), ONE / 2n, 'paid');
    // The carried 0.3 was consumed into the 0.5 paid (latest entry is paid); liability = 0.5.
    expect(await liability()).toBe(ONE / 2n);
  });

  it('a SUPERSEDED still-queued PAID entry is NOT dropped (both in-flight amounts reserved)', async () => {
    const sql = await getSql();
    // Recipient paid 0.3 in Apr (proposed, unexecuted), then paid 0.5 AGAIN in May (proposed).
    // A paid entry resets carry to 0, so the newer entry does NOT roll up the older one -- both
    // are independent in-flight payments earmarked in the Safe. A latest-only view would DROP
    // the Apr 0.3; the (a)+(b) union keeps both.
    await seedPartnerLiability(sql, '2026-04-01', 'proposed', 'cc'.repeat(20), (ONE * 3n) / 10n, 'paid');
    await seedPartnerLiability(sql, MAY, 'proposed', 'cc'.repeat(20), ONE / 2n, 'paid');
    expect(await liability()).toBe((ONE * 3n) / 10n + ONE / 2n); // 0.8, NOT 0.5
  });

  it('the rebate distributable reserves BOTH superseded in-flight payments (R + P <= new-fees delta)', async () => {
    const sql = await getSql();
    await seedRebateBasis(sql, MAY, 9n * ONE); // rebate basis (separate table)
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    // Two independent in-flight partner payments to the same recipient (superseded-paid case).
    await seedPartnerLiability(sql, '2026-03-01', 'proposed', 'cc'.repeat(20), (ONE * 3n) / 10n, 'paid');
    await seedPartnerLiability(sql, '2026-04-01', 'proposed', 'cc'.repeat(20), ONE / 2n, 'paid');
    mockBalanceWei = 10n * ONE; // newFees delta = 1 WETH; partner liability P = 0.8
    const r = await runBatcher(JUN);
    // distributable = (10 - 9) - 0.8 = 0.2 WETH (the OLD latest-only bug would leave 0.5).
    expect(r.poolWei).toBe(ONE / 5n);
    const [entry] = await sql<{ a: string }[]>`SELECT weth_amount_wei::text AS a FROM rebate_batch_entries`;
    // R + P <= new-fees delta: rebate paid (25% of 0.2 = 0.05) + partner 0.8 = 0.85 <= 1.0.
    expect(BigInt(entry!.a) + (ONE * 8n) / 10n).toBeLessThanOrEqual(1n * ONE);
  });

  it('when balance is fully partner-owed the rebate pays NOTHING (no_recipients)', async () => {
    const sql = await getSql();
    await seedRebateBasis(sql, MAY, 9n * ONE);
    await seedWallet(sql, 'aa'.repeat(20), 100_000);
    await seedPartnerLiability(sql, MAY, 'proposed', 'cc'.repeat(20), 2n * ONE, 'paid'); // > the 1 WETH delta
    mockBalanceWei = 10n * ONE;
    const r = await runBatcher(JUN);
    expect(r.status).toBe('no_recipients');
    expect(r.poolWei).toBe(0n);
  });
});
