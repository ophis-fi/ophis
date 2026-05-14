/**
 * Ophis rebate tier constants.
 *
 * MIRROR of packages/sdk/src/tiers.ts (and apps/rebate-indexer/src/tiers.ts).
 *
 * The cowswap fork lives in its own pnpm workspace and cannot import from the
 * outer monorepo (@ophis/sdk is not in this workspace's node_modules). We
 * duplicate the constants here following the same pattern as partnerFeeDefault.ts.
 *
 * Any time TIERS or POOL_SPLIT_BPS changes, change ALL THREE places in the same PR:
 *   1. apps/rebate-indexer/src/tiers.ts  (source of truth)
 *   2. packages/sdk/src/tiers.ts         (SDK mirror, validated by anti-drift test)
 *   3. apps/frontend/.../ophis/tiers.ts  (this file, frontend mirror)
 */

export interface Tier {
  readonly name: 'bronze' | 'silver' | 'gold' | 'platinum'
  readonly min_usd: number
  readonly rebate_pct: number
}

export const TIERS: readonly Tier[] = [
  { name: 'bronze', min_usd: 0, rebate_pct: 0.1 },
  { name: 'silver', min_usd: 5_000, rebate_pct: 0.2 },
  { name: 'gold', min_usd: 50_000, rebate_pct: 0.35 },
  { name: 'platinum', min_usd: 500_000, rebate_pct: 0.5 },
] as const

export const POOL_SPLIT_BPS = 5_000

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) throw new Error('assignTier: volume must be non-negative')
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!
  }
  return TIERS[0]!
}
