import { type AffiliateKind, FEE_SHARE_BPS, keepFractionBps, REGULAR_VOL_CAP_USD } from './rates.js';

/** One slice of a referrer's referred volume that shares a (chain, gross fee rate). */
export interface AffiliateVolumeBucket {
  readonly chainId: number;
  readonly volumeUsd: number;
  /** Effective gross fee rate (bps) for this slice: the per-trade rate from appData
   *  (clamped [1, retail]) or the retail default for unknown/historical rows. */
  readonly grossBps: number;
}

/** A referrer's referred volume for one cycle, split by (chain, gross fee rate). */
export interface AffiliateReferrer {
  readonly referrer_wallet: `0x${string}`;
  readonly kind: AffiliateKind;
  /**
   * Referred volume split into (chain, gross bps) buckets. The tier share is taken
   * of each bucket's ACTUAL fee (volume * bps), so per-channel fees accrue their
   * real kept fee (5 bps SDK = half of 10 bps retail; 1 bp stable = a tenth), and
   * the regular cap discards the LEAST-VALUABLE volume first even when one chain
   * carries mixed-rate trades.
   */
  readonly buckets: readonly AffiliateVolumeBucket[];
  /**
   * Optional payout redirect (migration 0007). When set, the WETH transfer goes here
   * instead of referrer_wallet; referrer_wallet stays the identity for credit/cap.
   * null/undefined => pay to referrer_wallet (backward-compatible default).
   */
  readonly payoutWallet?: `0x${string}` | null;
}

/** What a referrer is owed for one cycle. owedWei is the WETH actually paid. */
export interface AffiliateOwed {
  readonly referrer_wallet: `0x${string}`;
  readonly kind: AffiliateKind;
  /** Referred volume that earned the payout, AFTER the regular cap. */
  readonly referredVolumeUsd: number;
  readonly owedUsd: number;
  readonly owedWei: bigint;
  /** Carried through from AffiliateReferrer; null => pay to referrer_wallet. */
  readonly payoutWallet?: `0x${string}` | null;
}

/**
 * Fee-base-derived affiliate accrual. A referrer earns the tier share
 * (FEE_SHARE_BPS) of the ACTUAL net fee Ophis keeps on their referred volume:
 * `owed = feeShare * keepFraction(chain) * grossFeeUsd(chain)`, where grossFeeUsd
 * is SUM(value * per-trade bps)/1e4 from accrual. This honours the locked "share
 * of the fee Ophis KEEPS" policy across the per-channel fees (retail 10 bps, SDK
 * 5 bps, stable 1 bp): a 5 bps SDK order accrues half of a 10 bps retail order.
 * For an all-retail (10 bps) referrer this reduces EXACTLY to the published rates
 * (Regular 0.6 bps hosted / 0.8 OP; Partner 0.9 / 1.2).
 *
 * The Regular tier is hard-capped at REGULAR_VOL_CAP_USD of referred VOLUME per
 * cycle: volume past the cap earns ZERO. The cap is allocated HIGHEST-VALUE-FIRST
 * across (chain, bps) buckets (by net fee per $ of volume) so it never silently
 * discards the more valuable volume — including within one chain that mixes
 * rates. A partly-capped bucket earns its fee scaled by the fraction of its volume
 * within the cap. Partner is uncapped.
 *
 * USD owed is converted to WETH wei with `wethUsdPrice` (USD per WETH) using bigint
 * fixed-point so the 1e18 scale never touches float precision.
 *
 * Pure + deterministic. Returns one entry per referrer with owed_wei > 0 (zero-owed
 * referrers are excluded). Throws on a duplicate referrer or a non-positive price.
 *
 * Properties asserted in tests/affiliate/computeAffiliate.test.ts:
 *   - Regular flat-lines at the cap; Partner scales linearly.
 *   - Multi-chain cap is OP-first.
 *   - owedWei == owedUsd / price * 1e18 (within 1 wei).
 *   - Empty / zero-volume / zero-owed excluded.
 */
export function computeAffiliate(
  referrers: readonly AffiliateReferrer[],
  wethUsdPrice: number,
): AffiliateOwed[] {
  if (!Number.isFinite(wethUsdPrice) || wethUsdPrice <= 0) {
    throw new Error(`computeAffiliate: wethUsdPrice must be a positive finite number; got ${wethUsdPrice}`);
  }
  // price * 1e4 as bigint, so the *1e4 in owedUsdFp cancels in the wei division.
  const priceFp = BigInt(Math.round(wethUsdPrice * 10_000));
  if (priceFp <= 0n) throw new Error('computeAffiliate: wethUsdPrice rounds to zero');

  const seen = new Set<string>();
  const out: AffiliateOwed[] = [];

  for (const r of referrers) {
    if (seen.has(r.referrer_wallet)) {
      throw new Error(`computeAffiliate: duplicate referrer ${r.referrer_wallet}`);
    }
    seen.add(r.referrer_wallet);

    const feeShare = FEE_SHARE_BPS[r.kind] / 10_000; // 0.08 regular / 0.12 partner

    // Each (chain, bps) bucket carries its referred volume, the net owed if the
    // WHOLE bucket clears the cap (tier share of its ACTUAL gross fee = vol * bps),
    // and the net rate per $ of volume. Sorted by net-rate-per-$ DESC so the regular
    // cap discards the LEAST-valuable volume last — correct even within one chain
    // that mixes 10/5/1 bps trades, and OP-first when rates tie (OP keeps the full
    // fee). A partly-capped bucket earns its owed scaled by the fraction taken.
    const buckets = r.buckets
      .filter((b) => Number.isFinite(b.volumeUsd) && b.volumeUsd > 0 && Number.isFinite(b.grossBps) && b.grossBps > 0)
      .map((b) => {
        const grossFeeUsd = (b.volumeUsd * b.grossBps) / 10_000;
        const owedFull = feeShare * (keepFractionBps(b.chainId) / 10_000) * grossFeeUsd;
        return { vol: b.volumeUsd, owedFull, ratePerVol: owedFull / b.volumeUsd };
      })
      .sort((a, b) => b.ratePerVol - a.ratePerVol);

    let remaining = r.kind === 'regular' ? REGULAR_VOL_CAP_USD : Number.POSITIVE_INFINITY;
    let owedUsd = 0;
    let countedVolumeUsd = 0;
    for (const b of buckets) {
      if (remaining <= 0) break;
      const take = Math.min(b.vol, remaining);
      // Scale the bucket's owed by the fraction of its volume within the cap.
      owedUsd += b.owedFull * (take / b.vol);
      countedVolumeUsd += take;
      remaining -= take;
    }

    if (owedUsd <= 0) continue;

    const owedUsdFp = BigInt(Math.round(owedUsd * 10_000));
    const owedWei = (owedUsdFp * 10n ** 18n) / priceFp;
    if (owedWei <= 0n) continue;

    out.push({
      referrer_wallet: r.referrer_wallet,
      kind: r.kind,
      referredVolumeUsd: countedVolumeUsd,
      owedUsd,
      owedWei,
      payoutWallet: r.payoutWallet ?? null,
    });
  }

  return out;
}
