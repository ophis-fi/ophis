export interface Tier {
  readonly name: 'none' | 'bronze' | 'silver' | 'gold' | 'palladium' | 'platinum';
  readonly min_usd: number;
  readonly rebate_pct: number;
}

/**
 * Ophis rebate tiers. SOURCE OF TRUTH.
 *
 * Any change here propagates to the swap-page chip via @ophis/sdk
 * (packages/sdk/src/tiers.ts re-exports this) AND the cowswap-frontend mirror
 * (apps/frontend/.../ophis/tiers.ts). Adjust ALL THREE atomically; CI gate
 * scripts/check-tier-invariant.sh byte-matches this literal against the SDK.
 *
 * `none` is the sub-entry FLOOR: wallets below Bronze's $20k 30-day volume earn
 * NO rebate (rebate_pct 0 -> zero weight in computeShares -> excluded from the
 * payout). It keeps assignTier total (always returns a Tier, never null) so no
 * caller needs null-handling.
 */
export const TIERS: readonly Tier[] = [
  { name: 'none',      min_usd:         0, rebate_pct: 0.0 },
  { name: 'bronze',    min_usd:    20_000, rebate_pct: 0.10 },
  { name: 'silver',    min_usd:    50_000, rebate_pct: 0.15 },
  { name: 'gold',      min_usd:   100_000, rebate_pct: 0.25 },
  { name: 'palladium', min_usd:   500_000, rebate_pct: 0.35 },
  { name: 'platinum',  min_usd: 1_000_000, rebate_pct: 0.50 },
] as const;

/** Share of the Safe's WETH balance that becomes the monthly rebate pool. */
export const POOL_SPLIT_BPS = 5_000;

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) {
    throw new Error('assignTier: volume must be non-negative');
  }
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!;
  }
  return TIERS[0]!;
}
