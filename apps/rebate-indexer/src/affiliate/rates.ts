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
// ACCRUAL BASIS (updated 2026-06-19, per-trade fees): the fee is now per-channel
// (retail 10 bps, SDK/partner 5 bps, stable 1 bp), so accrual takes the tier share
// of the ACTUAL gross fee each trade carried, read from appData and stored per
// trade (trades.volume_fee_bps, clamped [1, retail]; NULL -> the retail default
// GROSS_FEE_BPS). owed = feeShare * keepFraction(chain) * SUM(value * actual_bps).
// For an ALL-RETAIL (10 bps) referrer this reduces EXACTLY to the published rates:
//   feeShare * GROSS_FEE_BPS * keepFraction(chain)
//   Regular hosted = 0.08 * 10 * 0.75 = 0.60 bps   (OP = 0.08 * 10 * 1.00 = 0.80 bps)
//   Partner hosted = 0.12 * 10 * 0.75 = 0.90 bps   (OP = 0.12 * 10 * 1.00 = 1.20 bps)
// A 5 bps SDK referrer earns HALF those; a 1 bp stable pair a tenth. The indexer
// still indexes only the CoW-hosted chains (Optimism not indexed yet).

export type AffiliateKind = 'regular' | 'partner';

/** Share of the NET fee paid to the affiliate, in basis points of the net fee. */
export const FEE_SHARE_BPS: Readonly<Record<AffiliateKind, number>> = {
  regular: 800, // 8%
  partner: 1200, // 12%
};

/** The RETAIL gross volume fee, in bps. Two roles now that the fee is per-channel:
 *  (1) the DEFAULT/legacy rate accrual assumes when a trade's actual
 *  trades.volume_fee_bps is NULL (historical rows or an unreadable fee), and
 *  (2) the CLAMP CEILING the fetcher applies to a trade's claimed volumeBps, so an
 *  attacker-crafted appData can never inflate the fee base above the retail rate.
 *  Accrual otherwise uses the ACTUAL per-trade bps; this is no longer the single
 *  assumed gross. Mirrors OPHIS_FRONTEND_OP_VOLUME_BPS in the frontend. */
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
 * Volume-derived UPPER-BOUND estimate of an affiliate's current-cycle earnings on
 * a USD referred volume, for the dashboard. Given only a volume (no per-trade fee
 * mix), it assumes the full RETAIL rate (GROSS_FEE_BPS) on the hosted keep
 * fraction, so it is the MOST the volume could earn. The settled monthly accrual
 * uses the ACTUAL per-trade fee, so real earnings are LOWER for any SDK-channel
 * (5 bps) or stable-pair (1 bp) volume. Regular affiliates are capped at
 * REGULAR_VOL_CAP_USD / month; partners are uncapped.
 */
export function estimateEarningsUsd(volumeUsd: number, kind: AffiliateKind): number {
  if (!Number.isFinite(volumeUsd) || volumeUsd <= 0) return 0;
  const cappedVolume = kind === 'regular' ? Math.min(volumeUsd, REGULAR_VOL_CAP_USD) : volumeUsd;
  // Any non-Optimism chain id yields the hosted keep fraction (0.75); the
  // indexer does not index Optimism, so all referred volume here is hosted.
  const HOSTED_CHAIN_ID = 1;
  return (cappedVolume * effectiveVolumeBps(kind, HOSTED_CHAIN_ID)) / 10_000;
}

/**
 * Fee-aware dashboard estimate of an affiliate's current-cycle earnings, from the
 * ACTUAL cycle fee base (feeBaseUsd = SUM(value * per-trade bps) / 1e4 on the
 * referrer's hosted volume). owed = feeShare * hostedKeep * feeBase, so it MATCHES
 * what the settled monthly accrual pays (a 5 bps SDK partner sees ~half of the old
 * retail-assumed figure, not 2x it). Regular caps on VOLUME at REGULAR_VOL_CAP_USD,
 * applied proportionally to the fee base (the dashboard estimate does not need the
 * accrual's exact least-valuable-first cap allocation). volumeUsd is the cycle
 * referred volume that produced feeBaseUsd, used only to compute the regular cap.
 */
export function estimateEarningsFromFeeBaseUsd(
  feeBaseUsd: number,
  volumeUsd: number,
  kind: AffiliateKind,
): number {
  if (!Number.isFinite(feeBaseUsd) || feeBaseUsd <= 0) return 0;
  const cappedFraction =
    kind === 'regular' && Number.isFinite(volumeUsd) && volumeUsd > REGULAR_VOL_CAP_USD
      ? REGULAR_VOL_CAP_USD / volumeUsd
      : 1;
  const HOSTED_CHAIN_ID = 1; // indexer covers only hosted chains; use the hosted keep fraction
  return (FEE_SHARE_BPS[kind] / 10_000) * (keepFractionBps(HOSTED_CHAIN_ID) / 10_000) * feeBaseUsd * cappedFraction;
}
