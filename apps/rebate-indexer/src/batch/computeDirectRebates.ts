import { assignTier } from '../tiers.js';
import type { EligibleWallet } from './computeShares.js';

/**
 * DIRECT-REBATE distribution (no pool). The alternative to computeShares' pool
 * model, selected by the REBATE_DIRECT_MODE flag in the batcher.
 *
 * `feesWei` is the NEW fees to distribute THIS cycle — the accrual delta the
 * batcher computes (current Safe WETH balance minus the basis recorded by the
 * last accounted cycle), NOT the Safe's whole balance. Each wallet's share of
 * those new fees is its volume-share, and its rebate is its tier's percentage of
 * that share:
 *
 *   fee_share_i = feesWei * volume_i / Σ_all(volume_j)   (all wallets, incl. 'none')
 *   rebate_i    = tier_pct_i * fee_share_i
 *
 * So a Platinum wallet (50%) gets back half of its share of the new fees; a
 * Bronze wallet (10%) a tenth; sub-$20k 'none' wallets get nothing but still
 * count toward the denominator (they generated fees, so they dilute everyone's
 * share). The batcher pays only these rebates from the fee Safe; the un-rebated
 * remainder of the new fees STAYS in the fee Safe as Ophis's profit. Because
 * rebates are computed on the per-cycle accrual delta, that profit sits below the
 * next cycle's basis and is never re-rebated — no sweep, no second vault.
 *
 * INVARIANT: Σrebates < feesWei. Both steps floor-divide and every tier_pct <=
 * 0.5, so Σrebates <= 0.5 * Σfee_share <= 0.5 * feesWei < feesWei.
 *
 * Mirrors computeShares' fixed-point + safety contract:
 *   - USD volume kept as fixed-point (x10^4) bigint; the x10^4 scaling cancels
 *     in the volume ratio, so it never affects the wei result.
 *   - Non-finite / non-positive volumes are skipped.
 *   - Caller must pass canonical (single-case) wallet addresses; a duplicate is
 *     a caller-contract violation and throws.
 *   - Zero-rebate wallets ('none' tier, or sub-wei rounding) are excluded from
 *     the returned Map, exactly like computeShares — so the batcher's existing
 *     `shares.size === 0 -> no_recipients` guard fires for an all-unranked month.
 */
export function computeDirectRebates(
  wallets: readonly EligibleWallet[],
  feesWei: bigint,
): Map<`0x${string}`, bigint> {
  if (feesWei <= 0n || wallets.length === 0) return new Map();

  // Pass 1: fixed-point volume per wallet + the total (INCLUDING 'none' wallets,
  // which dilute the per-wallet fee-share even though they earn no rebate).
  let totalVolumeFp = 0n;
  const volumeFp = new Map<`0x${string}`, bigint>();
  for (const w of wallets) {
    if (!Number.isFinite(w.volume_30d_usd) || w.volume_30d_usd <= 0) continue;
    const fp = BigInt(Math.round(w.volume_30d_usd * 10_000));
    if (fp === 0n) continue;
    if (volumeFp.has(w.wallet)) {
      throw new Error(`computeDirectRebates: duplicate wallet ${w.wallet}`);
    }
    volumeFp.set(w.wallet, fp);
    totalVolumeFp += fp;
  }
  if (totalVolumeFp === 0n) return new Map();

  // Pass 2: rebate = tier_pct * (feesWei * volume_i / Σvolume). Skip the 'none'
  // floor (rebate_pct 0) and any wallet whose rebate floors to 0 wei.
  const rebates = new Map<`0x${string}`, bigint>();
  for (const w of wallets) {
    const fp = volumeFp.get(w.wallet);
    if (fp === undefined) continue; // skipped in pass 1 (non-finite/zero)
    const pctFp = BigInt(Math.round(assignTier(w.volume_30d_usd).rebate_pct * 10_000)); // 0..5000
    if (pctFp === 0n) continue; // 'none' floor: no rebate
    const feeShareWei = (feesWei * fp) / totalVolumeFp; // floor
    const rebateWei = (feeShareWei * pctFp) / 10_000n; // floor
    if (rebateWei > 0n) rebates.set(w.wallet, rebateWei);
  }
  return rebates;
}
