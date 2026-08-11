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
// ACCRUAL BASIS: every order has a verified 1 bp base and may also realize
// capped price-improvement revenue. Today accrual includes only that verified
// base: CoW's executedProtocolFees is an intended amount, has no recipient, and
// does not prove payment to the Ophis Safe. Improvement revenue must not enter
// affiliate payouts until a future source reconciles actual recipient transfers.
// Legacy NULL rows use the creation-time fallback below.
// With no realized improvement, the 1 bp baseline reduces to:
//   feeShare * GROSS_FEE_BPS * keepFraction(chain)
//   Regular hosted = 0.08 * 1 * 0.75 = 0.06 bps   (OP = 0.08 bps)
//   Partner hosted = 0.12 * 1 * 0.75 = 0.09 bps   (OP = 0.12 bps)
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

/** Policy marker persisted by the API fetcher from CoW's authoritative
 * order.creationDate. Settlement time must never be used for this decision. */
export function undecodedFeeFallbackBpsForOrderCreatedAt(createdAt: Date): number {
  return createdAt.getTime() < Date.parse(ONE_BP_FEE_CUTOVER_AT)
    ? LEGACY_UNDECODED_FEE_BPS
    : GROSS_FEE_BPS;
}

/** Highest legacy Ophis volume fee that may appear on already-settled orders.
 * Keep historical accounting faithful; new orders are emitted at GROSS_FEE_BPS. */
export const HISTORICAL_OPHIS_FEE_MAX_BPS = 10;

/** CoW DAO's protocol cut on the partner fee, in bps (25%), on hosted chains. */
export const COW_TAKE_BPS = 2500;

/** Defensive display ceiling on an integrator's decoded OWN-fee rate (bps), used
 *  by the fetcher when it reads a non-Ophis partnerFee entry from a settled order's
 *  appData (migration 0014). appData is attacker-controllable, so a crafted entry
 *  cannot inflate the reported own-fee above this bound. The verified own-fee max is
 *  90 bps: the program-wide registered-partner ceiling. Hosted settlement now
 *  allows 190 bps aggregate so Ophis's 1+99 bps maximum can coexist with this
 *  full integrator fee. That is the correct clamp for a SETTLED order (the only kind this fetcher
 *  reads); a crafted entry above it never validates and never settles. */
export const OWN_FEE_MAX_BPS = 90;

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
 * Volume-derived BASELINE estimate of an affiliate's current-cycle earnings on
 * a USD referred volume, for the dashboard. Given only volume (no settled
 * improvement-fee mix), it assumes the 1 bp base on the hosted keep fraction.
 * The settled monthly accrual uses the ACTUAL per-trade effective fee, including
 * a separate legacy fallback for undecoded historical rows. Regular affiliates are capped at
 * REGULAR_VOL_CAP_USD / month; partners are uncapped.
 */
export function estimateEarningsUsd(volumeUsd: number, kind: AffiliateKind): number {
  if (!Number.isFinite(volumeUsd) || volumeUsd <= 0) return 0;
  const cappedVolume = kind === 'regular' ? Math.min(volumeUsd, REGULAR_VOL_CAP_USD) : volumeUsd;
  // This volume-only fallback has no chain mix, so it deliberately uses the
  // conservative hosted keep fraction (0.75).
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
