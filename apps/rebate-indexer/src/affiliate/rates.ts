// Affiliate / Partner program rates — single source of truth.
//
// LOCKED (Clement, 2026-06-09): pay a share of the fee Ophis KEEPS (net), never a
// bounty on volume. Two tiers:
//   - Regular: 8% of net fee, CAPPED at $1M referred volume / month. Public, self-serve.
//   - Partner: 12% of net fee, UNCAPPED. Invite-only (whitelisted), was "Super VIP".
//
// Net fee = gross volume fee minus CoW DAO's protocol cut: CoW takes 25% on the
// hosted chains, 0% on Optimism (sovereign Ophis backend). So Ophis keeps 75% on
// hosted, 100% on OP.
//
// DATA REALITY (grounding 2026-06-10): the indexer has NO per-trade fee
// (trades.partnerFeeWei is always NULL) and indexes ONLY the 11 CoW-hosted chains
// (Optimism is not indexed). So accrual is VOLUME-derived: a referrer earns
// `referred_volume * effectiveVolumeBps(tier, chainId)`. This is identical to the
// model doc's published rates because the rates were defined as bps-of-volume:
//   effectiveVolumeBps = feeShare * GROSS_FEE_BPS * keepFraction(chain)
//   Regular hosted = 0.08 * 10 * 0.75 = 0.60 bps   (OP = 0.08 * 10 * 1.00 = 0.80 bps)
//   Partner hosted = 0.12 * 10 * 0.75 = 0.90 bps   (OP = 0.12 * 10 * 1.00 = 1.20 bps)

export type AffiliateKind = 'regular' | 'partner';

/** Share of the NET fee paid to the affiliate, in basis points of the net fee. */
export const FEE_SHARE_BPS: Readonly<Record<AffiliateKind, number>> = {
  regular: 800, // 8%
  partner: 1200, // 12%
};

/** The standard gross volume fee, in bps. Stablecoin pairs pay 1 bp but the
 *  indexer does not flag stable trades, so v1 uses the standard rate for accrual
 *  (a slight overestimate for stable-stable pairs; flagged in the monthly report). */
export const GROSS_FEE_BPS = 10;

/** CoW DAO's protocol cut on the partner fee, in bps (25%), on hosted chains. */
export const COW_TAKE_BPS = 2500;

/** Hard cap on REFERRED VOLUME per referrer per calendar month, for Regular only.
 *  Partner is uncapped. Volume past the cap earns zero (hard-stop, Clement 2026-06-10). */
export const REGULAR_VOL_CAP_USD = 1_000_000;

/** Optimism mainnet — the only chain where Ophis keeps the full fee (no CoW cut).
 *  Not indexed yet, but the math is OP-ready so OP trades accrue correctly once fed. */
export const OPTIMISM_CHAIN_ID = 10;

/** Fraction of the gross fee Ophis keeps after CoW's cut, scaled by 1e4.
 *  Optimism keeps 100% (10_000); every hosted chain keeps 75% (7_500). */
export function keepFractionBps(chainId: number): number {
  return chainId === OPTIMISM_CHAIN_ID ? 10_000 : 10_000 - COW_TAKE_BPS;
}

/**
 * Effective affiliate rate in basis points OF TRADE VOLUME for a (tier, chain).
 * Returns a float bps (e.g. 0.6) — apply as `volumeUsd * bps / 10_000`.
 *
 *   = (FEE_SHARE_BPS/1e4) * GROSS_FEE_BPS * (keepFractionBps/1e4)
 */
export function effectiveVolumeBps(kind: AffiliateKind, chainId: number): number {
  return (FEE_SHARE_BPS[kind] / 10_000) * GROSS_FEE_BPS * (keepFractionBps(chainId) / 10_000);
}

/**
 * Volume-derived ESTIMATE of an affiliate's current-cycle earnings on a USD
 * referred volume, for the dashboard. Mirrors the monthly accrual
 * (volume * effectiveVolumeBps): the indexer covers only CoW-hosted chains, so
 * use the hosted keep fraction. Regular affiliates are capped at
 * REGULAR_VOL_CAP_USD / month; partners are uncapped. This is an estimate, not a
 * settled figure: it overestimates stable-stable pairs (which pay 1 bp, not the
 * 10 bp standard the indexer assumes) exactly as the monthly accrual does.
 */
export function estimateEarningsUsd(volumeUsd: number, kind: AffiliateKind): number {
  if (!Number.isFinite(volumeUsd) || volumeUsd <= 0) return 0;
  const cappedVolume = kind === 'regular' ? Math.min(volumeUsd, REGULAR_VOL_CAP_USD) : volumeUsd;
  // Any non-Optimism chain id yields the hosted keep fraction (0.75); the
  // indexer does not index Optimism, so all referred volume here is hosted.
  const HOSTED_CHAIN_ID = 1;
  return (cappedVolume * effectiveVolumeBps(kind, HOSTED_CHAIN_ID)) / 10_000;
}
