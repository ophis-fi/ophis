import { describe, it, expect } from 'vitest';
import { planAffiliatePayout, resolveAffiliatePayoutEnabled } from '../../src/affiliate/payoutPlan.js';
import type { AffiliateOwed } from '../../src/affiliate/computeAffiliate.js';

const WEI = 10n ** 18n;
const owed = (wallet: string, owedWei: bigint, kind: 'regular' | 'partner' = 'regular'): AffiliateOwed => ({
  referrer_wallet: wallet as `0x${string}`,
  kind,
  referredVolumeUsd: 1_000_000,
  owedUsd: 60,
  owedWei,
});

describe('planAffiliatePayout — double-spend guard + transfer plan', () => {
  it('builds transfers when rebate + affiliate fit the Safe balance', () => {
    const plan = planAffiliatePayout([owed('0xa', 1n * WEI), owed('0xb', 2n * WEI, 'partner')], 10n * WEI, 2n * WEI);
    expect(plan.blocked).toBe(false);
    expect(plan.totalOwedWei).toBe(3n * WEI);
    expect(plan.transfers).toHaveLength(2);
    expect(plan.transfers[0]).toMatchObject({ to: '0xa', amount: 1n * WEI, kind: 'regular' });
  });

  it('BLOCKS when rebate pool + affiliate would over-draw the Safe', () => {
    // balance 5, rebate 4, affiliate 2 -> 6 > 5 -> blocked, no transfers.
    const plan = planAffiliatePayout([owed('0xa', 2n * WEI)], 5n * WEI, 4n * WEI);
    expect(plan.blocked).toBe(true);
    expect(plan.transfers).toHaveLength(0);
    expect(plan.reason).toMatch(/exceed/);
  });

  it('allows exactly filling the Safe (rebate + affiliate == balance)', () => {
    const plan = planAffiliatePayout([owed('0xa', 6n * WEI)], 10n * WEI, 4n * WEI);
    expect(plan.blocked).toBe(false);
    expect(plan.totalOwedWei).toBe(6n * WEI);
  });

  it('drops zero-amount and zero-address recipients', () => {
    const plan = planAffiliatePayout(
      [owed('0xa', 0n), owed('0x0000000000000000000000000000000000000000', 1n * WEI), owed('0xc', 1n * WEI)],
      10n * WEI,
      0n,
    );
    expect(plan.transfers).toHaveLength(1);
    expect(plan.transfers[0]!.to).toBe('0xc');
    expect(plan.totalOwedWei).toBe(1n * WEI);
  });

  it('resolveAffiliatePayoutEnabled defaults OFF and is fail-loud on garbage', () => {
    delete process.env.AFFILIATE_PAYOUT_ENABLED;
    expect(resolveAffiliatePayoutEnabled()).toBe(false);
    process.env.AFFILIATE_PAYOUT_ENABLED = 'true';
    expect(resolveAffiliatePayoutEnabled()).toBe(true);
    process.env.AFFILIATE_PAYOUT_ENABLED = 'garbage';
    expect(() => resolveAffiliatePayoutEnabled()).toThrow();
    delete process.env.AFFILIATE_PAYOUT_ENABLED;
  });
});
