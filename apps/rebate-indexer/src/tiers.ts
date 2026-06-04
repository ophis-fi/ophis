export interface Tier {
  readonly name: 'bronze' | 'silver' | 'gold' | 'platinum';
  readonly min_usd: number;
  readonly rebate_pct: number;
}

/**
 * Ophis rebate tiers. SOURCE OF TRUTH.
 *
 * Any change here propagates to the swap-page chip via @ophis/sdk
 * (packages/sdk/src/tiers.ts re-exports this). Adjust both atomically.
 */
export const TIERS: readonly Tier[] = [
  { name: 'bronze',   min_usd:      0, rebate_pct: 0.10 },
  { name: 'silver',   min_usd:  5_000, rebate_pct: 0.20 },
  { name: 'gold',     min_usd: 50_000, rebate_pct: 0.35 },
  { name: 'platinum', min_usd: 500_000, rebate_pct: 0.50 },
] as const;

/** Share of the Safe's WETH balance that becomes the monthly rebate pool. */
export const POOL_SPLIT_BPS = 5_000;

/**
 * Effective pool split, FLAG-OVERRIDABLE for an A/B of the payout rate.
 * Defaults to POOL_SPLIT_BPS (50%). Set env REBATE_POOL_SPLIT_BPS=2000 to pay
 * out 20% of the Safe's WETH balance each cycle.
 *
 * IMPORTANT: this is a per-cycle PAYOUT RATE, not a retention split. The batcher
 * applies it to the Safe's WHOLE WETH balance every run and transfers only the
 * pool; the unpaid remainder is NOT swept, stays in the Safe, and is re-split
 * next cycle. So "20%" does NOT keep 80% as Ophis revenue -- it pays 20%, then
 * 16%, then 12.8% ... (geometric decay). To actually RETAIN revenue for Ophis,
 * a separate sweep of the (10000 - split) share to a revenue address is required
 * (deferred; implement before relying on the kicker as a margin source). (Review P3)
 *
 * The exported const POOL_SPLIT_BPS above stays 5000 (the cross-workspace
 * drift-guard mirrored in the SDK + frontend); only the batcher reads this
 * getter, so the default deploy is unchanged. NOTE: flipping this also requires
 * updating the "50%" rebate copy in docs/fees.md + the business page + the /tier
 * page (gated via REBATE_FLAT_FEE_BPS, see tier-page.ts) to match.
 */
export function getEffectivePoolSplitBps(): number {
  // Read the raw string first: Number('') === 0, so an unset OR empty/blank env
  // (REBATE_POOL_SPLIT_BPS= or an empty secret interpolation) must fall back to
  // the 5000 default, NOT silently drop rebates to 0%. An explicit "0" is still
  // honored as a deliberate kill switch.
  const raw = process.env.REBATE_POOL_SPLIT_BPS?.trim();
  if (raw === undefined || raw === '') return POOL_SPLIT_BPS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : POOL_SPLIT_BPS;
}

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) {
    throw new Error('assignTier: volume must be non-negative');
  }
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!;
  }
  return TIERS[0]!;
}
