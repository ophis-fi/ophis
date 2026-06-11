import { type AffiliateKind, effectiveVolumeBps, REGULAR_VOL_CAP_USD } from './rates.js';

/** A referrer's referred volume for one cycle, bucketed by the chain it traded on. */
export interface AffiliateReferrer {
  readonly referrer_wallet: `0x${string}`;
  readonly kind: AffiliateKind;
  /** chainId -> referred USD volume on that chain in the cycle (post-bound_at). */
  readonly volumeByChain: ReadonlyMap<number, number>;
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
 * Volume-derived affiliate accrual. The indexer has no per-trade fee
 * (trades.partnerFeeWei is always NULL), so a referrer earns
 * `referred_volume * effectiveVolumeBps(tier, chain)` — identical to the model
 * doc's published rates (Regular 0.6 bps hosted / 0.8 OP; Partner 0.9 / 1.2).
 *
 * The Regular tier is hard-capped at REGULAR_VOL_CAP_USD of referred volume per
 * cycle: volume past the cap earns ZERO. When a referrer's volume spans multiple
 * chains, the cap is allocated HIGHEST-RATE-FIRST (Optimism before hosted) so the
 * cap never silently discards the more valuable volume. Partner is uncapped.
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

    // Buckets sorted highest-rate-first so the regular cap discards low-rate volume first.
    const buckets = [...r.volumeByChain.entries()]
      .filter(([, vol]) => Number.isFinite(vol) && vol > 0)
      .map(([chainId, vol]) => ({ chainId, vol, bps: effectiveVolumeBps(r.kind, chainId) }))
      .sort((a, b) => b.bps - a.bps);

    let remaining = r.kind === 'regular' ? REGULAR_VOL_CAP_USD : Number.POSITIVE_INFINITY;
    let owedUsd = 0;
    let countedVolumeUsd = 0;
    for (const b of buckets) {
      if (remaining <= 0) break;
      const take = Math.min(b.vol, remaining);
      owedUsd += (take * b.bps) / 10_000;
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
