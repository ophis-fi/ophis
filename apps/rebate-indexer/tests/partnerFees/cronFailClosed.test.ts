import { describe, it, expect, beforeEach, vi } from 'vitest';

// P1.2 fail-closed: if partner accrual THROWS on the 1st, the shared-Safe rebate batcher AND
// affiliate payout must be SKIPPED that cycle (they share the Ophis Safe and could otherwise
// spend WETH owed to partners against a stale/absent liability). Own-fee (a separate sovereign
// Safe) must still run. The whole cron dependency graph is mocked so we can assert exactly which
// money steps ran. cron.ts imports db/index (throws without DATABASE_URL); set a dummy URL.
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/rebates_test';
process.env.SAFE_PROPOSER_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.AFFILIATE_PAYOUT_ENABLED = 'true';
process.env.OWN_FEE_PAYOUT_ENABLED = 'true';
process.env.PARTNER_FEE_PAYOUT_ENABLED = 'true';

// Mutable cron-shape state readable inside the hoisted vi.mock factories.
const cronState = vi.hoisted(() => ({
  firstOfMonth: true,
  batcherRanThisMonth: false,
  feed: { inserted: 0, skipped: 0, enriched: 0, capped: false, misconfigured: false },
  pricer: { priced: 0, failed: 0, anomalous: 0 },
}));

const runBatcher = vi.fn(async () => ({ status: 'no_recipients', batchId: 1, safeTxHash: null, recipientCount: 0, poolWei: 0n }));
const runAffiliatePayout = vi.fn(async () => ({ status: 'no_recipients' }));
const proposeOwnFeeBatches = vi.fn(async () => ({ checked: 0, proposed: 0, blocked: 0 }));
const proposePartnerFeeBatches = vi.fn(async () => ({ checked: 0, proposed: 0, blocked: 0 }));
const accruePartnerFees = vi.fn(async () => ({ status: 'computed', batchId: 1 }));

vi.mock('../../src/fetcher.js', () => ({
  DECODER_ETHFLOW_OWNERS: new Set<string>(),
  runFetcher: vi.fn(async () => ({ inserted: 0, owners: 0 })),
  pruneStaleWallets: vi.fn(async () => ({ pruned: 0 })),
  withPipelineLock: vi.fn(async (fn: () => Promise<void>) => { await fn(); return true; }),
}));
vi.mock('../../src/repair/routerTrades.js', () => ({
  repairRouterTrades: vi.fn(async () => ({ scanned: 0, repaired: 0, skipped: 0, dequeued: 0 })),
}));
vi.mock('../../src/pricer.js', () => ({ runPricer: vi.fn(async () => ({ priced: 0, failed: 0 })) }));
vi.mock('../../src/scorer.js', () => ({ runScorer: vi.fn(async () => ({})) }));
vi.mock('../../src/batcher.js', () => ({ runBatcher, isFirstOfMonth: () => cronState.firstOfMonth }));
vi.mock('../../src/batch/reconcile.js', () => ({ reconcileBatches: vi.fn(async () => ({})) }));
vi.mock('../../src/affiliate/deliverReport.js', () => ({ deliverMonthlyReport: vi.fn(async () => ({})) }));
vi.mock('../../src/affiliate/payout.js', () => ({ runAffiliatePayout, reconcileAffiliateBatches: vi.fn(async () => ({})) }));
vi.mock('../../src/affiliate/payoutPlan.js', () => ({ resolveAffiliatePayoutEnabled: () => true }));
vi.mock('../../src/ownFee/payout.js', () => ({ accrueOwnFee: vi.fn(async () => ({})), proposeOwnFeeBatches, reconcileOwnFeeBatches: vi.fn(async () => ({})) }));
vi.mock('../../src/ownFee/payoutPlan.js', () => ({ resolveOwnFeePayoutEnabled: () => true }));
vi.mock('../../src/partnerFees/fetch.js', () => ({ runPartnerFeeFetch: vi.fn(async () => ({ ...cronState.feed })) }));
vi.mock('../../src/partnerFees/pricePartnerFees.js', () => ({ runPartnerFeePricer: vi.fn(async () => ({ ...cronState.pricer })) }));
vi.mock('../../src/partnerFees/payout.js', () => ({
  accruePartnerFees,
  proposePartnerFeeBatches,
  reconcilePartnerFeeBatches: vi.fn(async () => ({})),
  resolvePartnerFeePayoutEnabled: () => true,
}));
vi.mock('../../src/telegram/alerter.js', () => ({
  alerts: { alert: vi.fn(async () => {}), nightlyComplete: vi.fn(async () => {}), batchReady: vi.fn(async () => {}) },
  notify: vi.fn(async () => {}),
}));
vi.mock('../../src/db/index.js', () => ({
  // One generic row serves every raw-sql read in cron: the Telegram summary (new_trades/
  // volume) and batcherRanThisMonth's EXISTS probe (ok).
  sql: vi.fn(async () => [{ ok: cronState.batcherRanThisMonth, new_trades: '0', volume: '0' }]),
  db: {},
  schema: {},
}));

describe('P1.2 cron fail-closed on partner accrual failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cronState.firstOfMonth = true;
    cronState.batcherRanThisMonth = false;
    cronState.feed = { inserted: 0, skipped: 0, enriched: 0, capped: false, misconfigured: false };
    cronState.pricer = { priced: 0, failed: 0, anomalous: 0 };
  });

  it('waits for the pipeline lock so a reward tick cannot cancel the daily refresh', async () => {
    const { runNightlyPipeline } = await import('../../src/cron.js');
    const { withPipelineLock } = await import('../../src/fetcher.js');

    await runNightlyPipeline();

    expect(withPipelineLock).toHaveBeenCalledWith(expect.any(Function), { wait: true });
  });

  it('SKIPS the rebate batcher + affiliate payout when partner accrual throws (own-fee still runs)', async () => {
    accruePartnerFees.mockRejectedValueOnce(new Error('accrual boom'));
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(accruePartnerFees).toHaveBeenCalledTimes(1); // it ran (and threw)
    expect(runBatcher).not.toHaveBeenCalled(); // shared-Safe rebate SKIPPED
    expect(runAffiliatePayout).not.toHaveBeenCalled(); // shared-Safe affiliate SKIPPED
    expect(proposePartnerFeeBatches).not.toHaveBeenCalled(); // no fresh batch to propose
    expect(proposeOwnFeeBatches).toHaveBeenCalled(); // separate sovereign Safe -> still runs
  });

  it('runs the rebate batcher + affiliate normally when partner accrual succeeds', async () => {
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(accruePartnerFees).toHaveBeenCalledTimes(1);
    expect(runBatcher).toHaveBeenCalledTimes(1);
    expect(runAffiliatePayout).toHaveBeenCalledTimes(1);
    expect(proposePartnerFeeBatches).toHaveBeenCalledTimes(1);
  });

  it('SKIPS the shared-Safe distribution when the fetch reported skipped (ambiguous) attributions', async () => {
    cronState.feed = { inserted: 0, skipped: 2, enriched: 0, capped: false, misconfigured: false };
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(accruePartnerFees).toHaveBeenCalledTimes(1); // accrual still records what it can
    expect(runBatcher).not.toHaveBeenCalled();
    expect(runAffiliatePayout).not.toHaveBeenCalled();
    expect(proposePartnerFeeBatches).not.toHaveBeenCalled();
  });

  it('SKIPS the shared-Safe distribution when the fetch was page-CAPPED (feed only partially drained)', async () => {
    cronState.feed = { inserted: 500, skipped: 0, enriched: 0, capped: true, misconfigured: false };
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(runBatcher).not.toHaveBeenCalled();
    expect(runAffiliatePayout).not.toHaveBeenCalled();
  });

  it('SKIPS the shared-Safe distribution when the feed config is MISSING on an active deployment', async () => {
    cronState.feed = { inserted: 0, skipped: 0, enriched: 0, capped: false, misconfigured: true };
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(runBatcher).not.toHaveBeenCalled();
    expect(runAffiliatePayout).not.toHaveBeenCalled();
  });

  it('SKIPS the shared-Safe distribution when the pricer quarantined an ANOMALOUS valuation', async () => {
    cronState.pricer = { priced: 3, failed: 0, anomalous: 1 };
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(runBatcher).not.toHaveBeenCalled();
    expect(runAffiliatePayout).not.toHaveBeenCalled();
  });

  it("CATCH-UP: mid-month with NO batcher heartbeat this month, the monthly section still runs (a failed 1st doesn't defer a month)", async () => {
    cronState.firstOfMonth = false;
    cronState.batcherRanThisMonth = false;
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(accruePartnerFees).toHaveBeenCalledTimes(1);
    expect(runBatcher).toHaveBeenCalledTimes(1);
  });

  it('mid-month with the batcher heartbeat already recorded, the monthly section does NOT run', async () => {
    cronState.firstOfMonth = false;
    cronState.batcherRanThisMonth = true;
    const { runNightlyPipeline } = await import('../../src/cron.js');
    await runNightlyPipeline();
    expect(accruePartnerFees).not.toHaveBeenCalled();
    expect(runBatcher).not.toHaveBeenCalled();
  });
});
