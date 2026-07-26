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

const runBatcher = vi.fn(async () => ({ status: 'no_recipients', batchId: 1, safeTxHash: null, recipientCount: 0, poolWei: 0n }));
const runAffiliatePayout = vi.fn(async () => ({ status: 'no_recipients' }));
const proposeOwnFeeBatches = vi.fn(async () => ({ checked: 0, proposed: 0, blocked: 0 }));
const proposePartnerFeeBatches = vi.fn(async () => ({ checked: 0, proposed: 0, blocked: 0 }));
const accruePartnerFees = vi.fn(async () => ({ status: 'computed', batchId: 1 }));

vi.mock('../../src/fetcher.js', () => ({
  runFetcher: vi.fn(async () => ({ inserted: 0, owners: 0 })),
  pruneStaleWallets: vi.fn(async () => ({ pruned: 0 })),
  withPipelineLock: vi.fn(async (fn: () => Promise<void>) => { await fn(); return true; }),
}));
vi.mock('../../src/pricer.js', () => ({ runPricer: vi.fn(async () => ({ priced: 0, failed: 0 })) }));
vi.mock('../../src/scorer.js', () => ({ runScorer: vi.fn(async () => ({})) }));
vi.mock('../../src/batcher.js', () => ({ runBatcher, isFirstOfMonth: () => true }));
vi.mock('../../src/batch/reconcile.js', () => ({ reconcileBatches: vi.fn(async () => ({})) }));
vi.mock('../../src/affiliate/deliverReport.js', () => ({ deliverMonthlyReport: vi.fn(async () => ({})) }));
vi.mock('../../src/affiliate/payout.js', () => ({ runAffiliatePayout, reconcileAffiliateBatches: vi.fn(async () => ({})) }));
vi.mock('../../src/affiliate/payoutPlan.js', () => ({ resolveAffiliatePayoutEnabled: () => true }));
vi.mock('../../src/ownFee/payout.js', () => ({ accrueOwnFee: vi.fn(async () => ({})), proposeOwnFeeBatches, reconcileOwnFeeBatches: vi.fn(async () => ({})) }));
vi.mock('../../src/ownFee/payoutPlan.js', () => ({ resolveOwnFeePayoutEnabled: () => true }));
vi.mock('../../src/partnerFees/fetch.js', () => ({ runPartnerFeeFetch: vi.fn(async () => ({ inserted: 0, skipped: 0, enriched: 0 })) }));
vi.mock('../../src/partnerFees/pricePartnerFees.js', () => ({ runPartnerFeePricer: vi.fn(async () => ({ priced: 0, failed: 0 })) }));
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
  sql: vi.fn(async () => [{ new_trades: '0', volume: '0' }]),
  db: {},
  schema: {},
}));

describe('P1.2 cron fail-closed on partner accrual failure', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
