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
 * Effective pool split, FLAG-OVERRIDABLE for an A/B of a trimmed rebate.
 * Defaults to POOL_SPLIT_BPS (50%). Set env REBATE_POOL_SPLIT_BPS=2000 to trim
 * the monthly rebate pool to a 20% loyalty kicker (keeps more fee revenue for
 * Ophis). The exported const POOL_SPLIT_BPS above stays 5000 (it is the
 * cross-workspace drift-guard value mirrored in the SDK + frontend); only the
 * batcher's runtime pool computation reads this getter, so the default deploy
 * is unchanged. NOTE: flipping this also requires updating the "50%" copy in
 * docs/fees.md + the business page to match the new split.
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
