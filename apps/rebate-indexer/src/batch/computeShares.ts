import { assignTier } from '../tiers.js';

export interface EligibleWallet {
  readonly wallet: `0x${string}`;
  readonly volume_30d_usd: number;
}

/**
 * Weighted-share distribution. See spec §"Volume → Tier → Rebate math" for derivation.
 *
 * Caller must normalize wallet addresses to a single canonical case before passing.
 * The internal Map treats different cases as distinct keys, which would split shares.
 *
 * Properties enforced by tests in tests/computeShares.test.ts:
 *   - Σ shares ≤ pool, always
 *   - Single wallet gets the entire pool
 *   - Zero pool / zero wallets → empty result
 *
 * Returns Map<wallet, share_wei>. Wallets with zero share (zero volume, zero pool,
 * or pool/total_weight rounds to 0) are excluded from the returned map.
 */
export function computeShares(
  wallets: readonly EligibleWallet[],
  pool_wei: bigint,
): Map<`0x${string}`, bigint> {
  if (pool_wei <= 0n || wallets.length === 0) return new Map();

  // Fixed-point: USD × 10^4 (preserves cents), rebate% × 10^4 (preserves bps).
  // weight = volume_fp × pct_fp (unitless, comparable across wallets).
  let total_weight = 0n;
  const weights = new Map<`0x${string}`, bigint>();
  for (const w of wallets) {
    if (!Number.isFinite(w.volume_30d_usd) || w.volume_30d_usd <= 0) continue;
    const { rebate_pct } = assignTier(w.volume_30d_usd);
    const volume_fp = BigInt(Math.round(w.volume_30d_usd * 10_000));
    const pct_fp = BigInt(Math.round(rebate_pct * 10_000));
    const weight = volume_fp * pct_fp;
    if (weight === 0n) continue;
    if (weights.has(w.wallet)) {
      throw new Error(`computeShares: duplicate wallet ${w.wallet}`);
    }
    weights.set(w.wallet, weight);
    total_weight += weight;
  }
  if (total_weight === 0n) return new Map();

  const shares = new Map<`0x${string}`, bigint>();
  for (const [wallet, weight] of weights) {
    const share = (pool_wei * weight) / total_weight;                // floor
    if (share > 0n) shares.set(wallet, share);
  }
  return shares;
}
