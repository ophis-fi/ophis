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
  readonly name: 'bronze' | 'silver' | 'gold' | 'platinum';
  readonly min_usd: number;
  readonly rebate_pct: number;
}

// Deep-frozen: both the array and each tier object are immutable at runtime, so
// a consumer (or prototype pollution) can't change a min_usd / rebate_pct and
// silently alter assignTier or a caller's rebate math.
export const TIERS: readonly Tier[] = Object.freeze(
  ([
    { name: 'bronze',   min_usd:      0, rebate_pct: 0.10 },
    { name: 'silver',   min_usd:  5_000, rebate_pct: 0.20 },
    { name: 'gold',     min_usd: 50_000, rebate_pct: 0.35 },
    { name: 'platinum', min_usd: 500_000, rebate_pct: 0.50 },
  ] as Tier[]).map((t) => Object.freeze(t)),
);

export const POOL_SPLIT_BPS = 5_000;

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) throw new Error('assignTier: volume must be non-negative');
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!;
  }
  return TIERS[0]!;
}
