import { describe, it, expect } from 'vitest';
import { planAffiliatePayout } from '../../src/affiliate/payoutPlan.js';
import type { AffiliateOwed } from '../../src/affiliate/computeAffiliate.js';

// The affiliate over-draw guard SUBTRACTS the outstanding partner liability from its available
// balance (money-correctness, partner-fees Phase B), so the same Safe WETH is never paid as
// both an affiliate payout and a partner payout.

const ONE = 10n ** 18n;
const owed = (wei: bigint): AffiliateOwed => ({
  referrer_wallet: '0x1111111111111111111111111111111111111111',
  kind: 'regular',
  referredVolumeUsd: 1_000,
  owedUsd: 100,
  owedWei: wei,
  payoutWallet: null,
});

describe('planAffiliatePayout partner-liability reservation', () => {
  it('BLOCKS when affiliate + rebate + partner liability exceed the balance', () => {
    // Balance 1 WETH; rebate 0.3 queued; partner 0.5 owed; affiliate wants 0.4 -> 1.2 > 1 -> block.
    const plan = planAffiliatePayout([owed((ONE * 4n) / 10n)], ONE, (ONE * 3n) / 10n, ONE / 2n);
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toMatch(/partner/i);
  });

  it('does NOT block when it fits net of the partner liability', () => {
    // Balance 1 WETH; rebate 0.1; partner 0.2; affiliate 0.4 -> 0.7 <= 1 -> ok.
    const plan = planAffiliatePayout([owed((ONE * 4n) / 10n)], ONE, ONE / 10n, ONE / 5n);
    expect(plan.blocked).toBe(false);
    expect(plan.transfers).toHaveLength(1);
  });

  it('is byte-compatible with the pre-partner 3-arg callers (default 0n)', () => {
    // Same case as above WITHOUT the partner arg: only rebate reserved -> still fits.
    const plan = planAffiliatePayout([owed((ONE * 4n) / 10n)], ONE, ONE / 10n);
    expect(plan.blocked).toBe(false);
    expect(plan.totalOwedWei).toBe((ONE * 4n) / 10n);
  });

  it('the partner reservation alone can flip a payout from OK to BLOCKED', () => {
    const args = [[owed(ONE / 2n)], ONE, 0n] as const;
    expect(planAffiliatePayout(...args).blocked).toBe(false); // 0.5 <= 1
    expect(planAffiliatePayout(...args, (ONE * 6n) / 10n).blocked).toBe(true); // 0.5 + 0.6 > 1
  });
});
