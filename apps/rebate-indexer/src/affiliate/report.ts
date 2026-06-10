import type { AffiliateOwed } from './computeAffiliate.js';
import { GROSS_FEE_BPS, keepFractionBps } from './rates.js';

// Monthly settlement report: a full, accurate accounting of fees -> rebate +
// affiliate + retained, with rebate and affiliate kept in SEPARATE sections so the
// numbers never mix. Delivered to Telegram + stored (the delivery is wired in the
// caller; this module is a pure, testable assembler).
//
// GROUND TRUTH for the payout math is the Safe WETH balance at cycle time (Clement
// sweeps Ophis's retained profit out each month, so the balance ~= the month's
// fees). Rebate (21.25% of balance, POOL mode) + affiliate (computed owed) +
// retained (the rest, = what Clement withdraws) reconcile exactly against it.
//
// The volume-derived gross/net fees are an ATTRIBUTION view (the indexer has no
// per-trade fee and indexes only hosted chains), shown alongside with a COVERAGE
// gap vs the Safe balance so any under/over-indexing is visible, not hidden.

const WEI = 10n ** 18n;

function weiToEth(wei: bigint): number {
  // For display only (4dp). Payout math stays in bigint wei.
  return Number((wei * 10_000n) / WEI) / 10_000;
}

export interface ReportInput {
  readonly cycleMonth: string; // 'YYYY-MM'
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** On-chain WETH balance of the fee Safe at cycle time (payout base, ground truth). */
  readonly safeWethBalanceWei: bigint;
  readonly wethUsdPrice: number;
  /** Rebate pool = POOL_SPLIT_BPS of the Safe balance (computed by the rebate batcher). */
  readonly rebatePoolWei: bigint;
  readonly rebateRecipientCount: number;
  /** Affiliate owed this cycle, per referrer (from computeAffiliate). */
  readonly affiliate: readonly AffiliateOwed[];
  /** Total indexed Ophis volume this period, by chain (attribution view). */
  readonly volumeByChain: ReadonlyMap<number, number>;
}

export interface MonthlyReport {
  readonly cycleMonth: string;
  readonly safeWethBalanceWei: bigint;
  readonly rebateWei: bigint;
  readonly affiliateWei: bigint;
  readonly retainedWei: bigint;
  /** rebate + affiliate + retained == safeWethBalanceWei (always true unless overflow). */
  readonly reconciliationOk: boolean;
  /** True if rebate + affiliate exceed the Safe balance (would over-pay — blocks payout). */
  readonly overflow: boolean;
  readonly totalVolumeUsd: number;
  /** Volume-derived net fee Ophis should have earned (attribution estimate). */
  readonly impliedNetFeeUsd: number;
  /** (safeBalanceUsd - impliedNetFeeUsd) / impliedNetFeeUsd; flags indexing coverage gaps. */
  readonly coverageGapPct: number;
  readonly text: string;
}

/**
 * Assemble the monthly settlement report. Pure + deterministic.
 *
 * retained = safeBalance - rebatePool - Σ affiliate owed. If rebate + affiliate
 * exceed the balance (should never happen: rebate is 21.25% and affiliate is sub-bps
 * of volume, but guard it), `overflow` is set, `retainedWei` is clamped to 0, and the
 * text flags it as a BLOCK so the caller does not propose an over-paying payout.
 */
export function assembleReport(input: ReportInput): MonthlyReport {
  const affiliateWei = input.affiliate.reduce((acc, a) => acc + a.owedWei, 0n);
  const rebateWei = input.rebatePoolWei;
  const paidWei = rebateWei + affiliateWei;
  const overflow = paidWei > input.safeWethBalanceWei;
  const retainedWei = overflow ? 0n : input.safeWethBalanceWei - paidWei;
  const reconciliationOk = !overflow && rebateWei + affiliateWei + retainedWei === input.safeWethBalanceWei;

  // Attribution: implied net fee from indexed volume (gross 10bps minus CoW cut per chain).
  let totalVolumeUsd = 0;
  let impliedNetFeeUsd = 0;
  for (const [chainId, vol] of input.volumeByChain) {
    if (!Number.isFinite(vol) || vol <= 0) continue;
    totalVolumeUsd += vol;
    impliedNetFeeUsd += (vol * GROSS_FEE_BPS * (keepFractionBps(chainId) / 10_000)) / 10_000;
  }
  const safeBalanceUsd = weiToEth(input.safeWethBalanceWei) * input.wethUsdPrice;
  const coverageGapPct = impliedNetFeeUsd > 0 ? (safeBalanceUsd - impliedNetFeeUsd) / impliedNetFeeUsd : 0;

  const regular = input.affiliate.filter((a) => a.kind === 'regular');
  const partner = input.affiliate.filter((a) => a.kind === 'partner');
  const usd = (wei: bigint): string => `$${(weiToEth(wei) * input.wethUsdPrice).toFixed(2)}`;
  const eth = (wei: bigint): string => `${weiToEth(wei).toFixed(4)} WETH`;

  const lines = [
    `OPHIS MONTHLY SETTLEMENT — ${input.cycleMonth}`,
    `Period: ${input.periodStart.toISOString().slice(0, 10)} to ${input.periodEnd.toISOString().slice(0, 10)}`,
    ``,
    `1. ATTRIBUTION (volume-derived, indexed hosted chains)`,
    `   Total volume: $${totalVolumeUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `   Implied net fee (Ophis keeps): $${impliedNetFeeUsd.toFixed(2)}`,
    ``,
    `2. SAFE (ground truth, WETH @ $${input.wethUsdPrice.toFixed(2)})`,
    `   Fee Safe WETH balance: ${eth(input.safeWethBalanceWei)} (${usd(input.safeWethBalanceWei)})`,
    `   Coverage vs attribution: ${(coverageGapPct * 100).toFixed(1)}% ${Math.abs(coverageGapPct) > 0.15 ? '[REVIEW]' : 'OK'}`,
    ``,
    `3. REBATE -> traders (21.25% of WETH balance)`,
    `   ${eth(rebateWei)} (${usd(rebateWei)}) across ${input.rebateRecipientCount} wallet(s)`,
    ``,
    `4. AFFILIATE -> referrers (${input.affiliate.length} payee(s); SEPARATE from rebates)`,
    `   Regular (${regular.length}): ${eth(regular.reduce((a, r) => a + r.owedWei, 0n))}`,
    `   Partner (${partner.length}): ${eth(partner.reduce((a, r) => a + r.owedWei, 0n))}`,
    `   Total affiliate: ${eth(affiliateWei)} (${usd(affiliateWei)})`,
    ``,
    `5. OPHIS RETAINED -> withdraw after payouts`,
    `   ${eth(retainedWei)} (${usd(retainedWei)})`,
    ``,
    `6. RECONCILIATION`,
    overflow
      ? `   BLOCK: rebate + affiliate (${eth(paidWei)}) EXCEED the Safe balance (${eth(input.safeWethBalanceWei)}). Payout withheld.`
      : `   rebate + affiliate + retained = balance: ${reconciliationOk ? 'OK' : 'MISMATCH'}`,
  ];

  return {
    cycleMonth: input.cycleMonth,
    safeWethBalanceWei: input.safeWethBalanceWei,
    rebateWei,
    affiliateWei,
    retainedWei,
    reconciliationOk,
    overflow,
    totalVolumeUsd,
    impliedNetFeeUsd,
    coverageGapPct,
    text: lines.join('\n'),
  };
}
