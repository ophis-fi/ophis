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
// ACCRUAL BASIS: the Ophis fee is 1 bp on every channel, so accrual takes the tier share
// of the ACTUAL gross fee each trade carried, read from appData and stored per
// trade. New orders use GROSS_FEE_BPS; only NULL rows settled before the fee
// rollout cutover use LEGACY_UNDECODED_FEE_BPS until they are backfilled.
// At the canonical 1 bp fee this reduces to:
//   feeShare * GROSS_FEE_BPS * keepFraction(chain)
//   Regular hosted = 0.08 * 1 * 0.75 = 0.06 bps   (OP = 0.08 bps)
//   Partner hosted = 0.12 * 1 * 0.75 = 0.09 bps   (OP = 0.12 bps)
// The indexer
// still indexes only the CoW-hosted chains (Optimism not indexed yet).

export type AffiliateKind = 'regular' | 'partner';

/** Share of the NET fee paid to the affiliate, in basis points of the net fee. */
export const FEE_SHARE_BPS: Readonly<Record<AffiliateKind, number>> = {
  regular: 800, // 8%
  partner: 1200, // 12%
};

/** Canonical current Ophis fee emitted by every new-order surface. */
export const GROSS_FEE_BPS = 1;

/** Conservative accounting fallback for already-settled rows whose fee could
 * not be decoded. Before per-trade fee persistence, NULL meant the then-current
 * 10 bps retail rate; changing this with the new-order default would underpay
 * historical referrals. Remove only after every nullable settled row is
 * deterministically backfilled. */
export const LEGACY_UNDECODED_FEE_BPS = 10;

/** First instant after the 1 bp production rollout was complete on every order
 * surface (the final frontend deploy completed at 2026-08-11T12:44:16Z).
 * A NULL fee before this boundary is genuinely legacy; a NULL fee at or after
 * it is a current surplus/price-improvement fee and must never inherit 10 bps. */
export const ONE_BP_FEE_CUTOVER_AT = '2026-08-11T12:45:00.000Z';

/** Highest legacy Ophis volume fee that may appear on already-settled orders.
 * Keep historical accounting faithful; new orders are emitted at GROSS_FEE_BPS. */
export const HISTORICAL_OPHIS_FEE_MAX_BPS = 10;

/** CoW DAO's protocol cut on the partner fee, in bps (25%), on hosted chains. */
export const COW_TAKE_BPS = 2500;

/** Defensive display ceiling on an integrator's decoded OWN-fee rate (bps), used
 *  by the fetcher when it reads a non-Ophis partnerFee entry from a settled order's
 *  appData (migration 0014). appData is attacker-controllable, so a crafted entry
 *  cannot inflate the reported own-fee above this bound. The verified own-fee max is
 *  99 bps: the aggregate of an integrator's own entry plus the 1 bp Ophis base is
 *  bounded by the 100 bps aggregate cap, so the own entry alone can settle at most
 *  99 bps. That is the correct clamp for a SETTLED order (the only kind this fetcher
 *  reads); a crafted entry above it never validates and never settles. */
export const OWN_FEE_MAX_BPS = 99;

/** Hard cap on REFERRED VOLUME per referrer per calendar month, for Regular only.
 *  Partner is uncapped. Volume past the cap earns zero (hard-stop, Clement 2026-06-10). */
export const REGULAR_VOL_CAP_USD = 1_000_000;

export const OPTIMISM_CHAIN_ID = 10;
export const UNICHAIN_CHAIN_ID = 130;
export const ROBINHOOD_CHAIN_ID = 4663;

/** Ophis-SOVEREIGN chains: Ophis runs its own orderbook + settlement, so there is
 *  NO CoW DAO service-fee cut and Ophis keeps the full fee (100%). Optimism (10),
 *  Unichain (130), and Robinhood (4663) are sovereign; every CoW-hosted chain pays
 *  CoW's 25% cut (keeps 75%).
 *  This set is the SINGLE source of truth for the keep fraction — keepFractionBps() and
 *  the api.ts payout SQL both derive from it, so adding a sovereign chain is one edit. */
export const SOVEREIGN_CHAIN_IDS: ReadonlySet<number> = new Set([
  OPTIMISM_CHAIN_ID,
  UNICHAIN_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
]);

/**
 * Chains where the own-fee Safe payout pipeline is configured end to end.
 * Robinhood is sovereign for affiliate keep-rate accounting, but stays out of
 * this set until its WETH, Safe transaction service, and cron payout lane exist.
 */
export const OWN_FEE_GUARANTEED_CHAIN_IDS: ReadonlySet<number> = new Set([
  OPTIMISM_CHAIN_ID,
  UNICHAIN_CHAIN_ID,
]);

/** Fraction of the gross fee Ophis keeps after CoW's cut, scaled by 1e4.
 *  Sovereign chains keep 100% (10_000); every hosted chain keeps 75% (7_500). */
export function keepFractionBps(chainId: number): number {
  return SOVEREIGN_CHAIN_IDS.has(chainId) ? 10_000 : 10_000 - COW_TAKE_BPS;
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
 * mix), it assumes the canonical current rate (GROSS_FEE_BPS) on the hosted keep
 * fraction. The settled monthly accrual uses the ACTUAL per-trade fee, including
 * a separate legacy fallback for undecoded historical rows. Regular affiliates are capped at
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
 * ACTUAL cycle NET fee (netFeeUsd = SUM(value * per-trade bps * keepFraction(chain))
 * / 1e8, with the per-chain CoW cut already applied at the SQL layer so Optimism
 * volume keeps 100% and hosted volume 75%, matching the accrual). owed = feeShare *
 * netFee, so it MATCHES what the settled monthly accrual pays and does not
 * understate operated-chain volume by 25%. Regular caps on VOLUME at
 * REGULAR_VOL_CAP_USD, applied proportionally to
 * the net fee (the dashboard estimate does not need the accrual's exact
 * least-valuable-first cap allocation). volumeUsd is the cycle referred volume that
 * produced netFeeUsd, used only to compute the regular cap.
 */
export function estimateEarningsFromNetFeeUsd(
  netFeeUsd: number,
  volumeUsd: number,
  kind: AffiliateKind,
): number {
  if (!Number.isFinite(netFeeUsd) || netFeeUsd <= 0) return 0;
  const cappedFraction =
    kind === 'regular' && Number.isFinite(volumeUsd) && volumeUsd > REGULAR_VOL_CAP_USD
      ? REGULAR_VOL_CAP_USD / volumeUsd
      : 1;
  return (FEE_SHARE_BPS[kind] / 10_000) * netFeeUsd * cappedFraction;
}
