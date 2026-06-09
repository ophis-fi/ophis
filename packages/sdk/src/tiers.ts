/**
 * MIRROR of apps/rebate-indexer/src/tiers.ts.
 *
 * The cowswap fork lives in its own pnpm workspace and cannot import from
 * apps/rebate-indexer, so we duplicate the constants here. A CI check in
 * tests/tiers.test.ts asserts the two stay in sync by importing both modules
 * and comparing their exports.
 *
 * Any time TIERS or POOL_SPLIT_BPS changes, change BOTH places in the same PR.
 */
export interface Tier {
  readonly name: 'none' | 'bronze' | 'silver' | 'gold' | 'palladium' | 'platinum';
  readonly min_usd: number;
  readonly rebate_pct: number;
}

// The `[...] as const` literal form is REQUIRED: a CI invariant
// (scripts/check-tier-invariant.sh) canonicalizes this exact array literal and
// asserts it byte-matches apps/rebate-indexer/src/tiers.ts. Do not wrap it.
// `none` is the sub-entry floor (rebate 0 -> excluded from payout); see the
// indexer source for the rationale.
export const TIERS: readonly Tier[] = [
  { name: 'none',      min_usd:         0, rebate_pct: 0.0 },
  { name: 'bronze',    min_usd:    20_000, rebate_pct: 0.10 },
  { name: 'silver',    min_usd:    50_000, rebate_pct: 0.15 },
  { name: 'gold',      min_usd:   100_000, rebate_pct: 0.25 },
  { name: 'palladium', min_usd:   500_000, rebate_pct: 0.35 },
  { name: 'platinum',  min_usd: 1_000_000, rebate_pct: 0.50 },
] as const;
// Deep-freeze in place (the readonly types above are compile-time only): block
// runtime mutation of a tier threshold, which would silently change assignTier
// and any consumer's rebate math.
TIERS.forEach((tier) => Object.freeze(tier));
Object.freeze(TIERS);

export const POOL_SPLIT_BPS = 2_125;

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) throw new Error('assignTier: volume must be non-negative');
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!;
  }
  return TIERS[0]!;
}
