import { describe, it, expect } from 'vitest';
import { assembleReport, type ReportInput } from '../../src/affiliate/report.js';
import type { AffiliateOwed } from '../../src/affiliate/computeAffiliate.js';

const WEI = 10n ** 18n;
const HOSTED = 100;
const PRICE = 2_500;

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  cycleMonth: '2026-06',
  periodStart: new Date('2026-06-01T00:00:00Z'),
  periodEnd: new Date('2026-07-01T00:00:00Z'),
  safeWethBalanceWei: 10n * WEI, // 10 WETH = $25,000
  wethUsdPrice: PRICE,
  rebatePoolWei: 2125n * WEI / 10_000n * 10n, // 21.25% of 10 WETH = 2.125 WETH
  rebateRecipientCount: 5,
  affiliate: [],
  volumeByChain: new Map([[HOSTED, 3_000_000]]),
  ...over,
});

describe('assembleReport — monthly settlement', () => {
  it('reconciles: rebate + affiliate + retained == balance', () => {
    const affiliate: AffiliateOwed[] = [
      { referrer_wallet: '0xa', kind: 'regular', referredVolumeUsd: 1_000_000, owedUsd: 60, owedWei: (60n * WEI) / BigInt(PRICE) },
      { referrer_wallet: '0xb', kind: 'partner', referredVolumeUsd: 5_000_000, owedUsd: 450, owedWei: (450n * WEI) / BigInt(PRICE) },
    ];
    const r = assembleReport(base({ affiliate }));
    expect(r.reconciliationOk).toBe(true);
    expect(r.overflow).toBe(false);
    expect(r.rebateWei + r.affiliateWei + r.retainedWei).toBe(r.safeWethBalanceWei);
  });

  it('keeps regular and affiliate totals separate from rebate', () => {
    const affiliate: AffiliateOwed[] = [
      { referrer_wallet: '0xa', kind: 'regular', referredVolumeUsd: 1_000_000, owedUsd: 60, owedWei: 24n * 10n ** 15n },
      { referrer_wallet: '0xb', kind: 'partner', referredVolumeUsd: 5_000_000, owedUsd: 450, owedWei: 180n * 10n ** 15n },
    ];
    const r = assembleReport(base({ affiliate }));
    expect(r.affiliateWei).toBe(24n * 10n ** 15n + 180n * 10n ** 15n);
    // rebate is independent of affiliate
    expect(r.rebateWei).toBe(2125n * WEI / 10_000n * 10n);
    expect(r.text).toContain('REBATE -> traders');
    expect(r.text).toContain('AFFILIATE -> referrers');
    expect(r.text).toContain('OPHIS RETAINED');
  });

  it('flags overflow and withholds payout when rebate + affiliate exceed the balance', () => {
    const affiliate: AffiliateOwed[] = [
      { referrer_wallet: '0xa', kind: 'partner', referredVolumeUsd: 9_999_999, owedWei: 9n * WEI, owedUsd: 22500 },
    ];
    // rebate 2.125 + affiliate 9 = 11.125 > 10 balance
    const r = assembleReport(base({ affiliate }));
    expect(r.overflow).toBe(true);
    expect(r.retainedWei).toBe(0n);
    expect(r.reconciliationOk).toBe(false);
    expect(r.text).toContain('BLOCK');
  });

  it('computes a coverage gap between attribution and the Safe balance', () => {
    // $3M hosted volume -> implied net = 3M * 10bps * 0.75 = $2,250.
    // Safe balance 10 WETH * $2500 = $25,000 -> huge positive gap -> [REVIEW].
    const r = assembleReport(base());
    expect(r.impliedNetFeeUsd).toBeCloseTo(2250, 2);
    expect(Math.abs(r.coverageGapPct)).toBeGreaterThan(0.15);
    expect(r.text).toContain('[REVIEW]');
  });

  it('empty affiliate -> affiliateWei 0, still reconciles', () => {
    const r = assembleReport(base());
    expect(r.affiliateWei).toBe(0n);
    expect(r.rebateWei + r.retainedWei).toBe(r.safeWethBalanceWei);
  });
});
