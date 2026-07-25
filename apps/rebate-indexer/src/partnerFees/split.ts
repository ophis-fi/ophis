// Pure 80/20 partner-fee split + USD/WETH fixed-point helpers. NO db / network
// imports so this is unit- and property-testable in isolation (partner-fees Phase B).
//
// The partner earns PARTNER_FEE_PARTNER_SHARE_BPS of every protocol fee collected on
// their attributed trades; Ophis retains the remainder. A recipient is only PAID once
// their accrued owed reaches MIN_PARTNER_PAYOUT_USD; below that it CARRIES forward.

/** The partner's share of each collected protocol fee, in bps (80%). Ophis keeps 20%. */
export const PARTNER_FEE_PARTNER_SHARE_BPS = 8000;

/** Minimum owed USD to trigger a WETH payout this cycle; below this the owed carries. */
export const MIN_PARTNER_PAYOUT_USD = 25;

/**
 * Split a collected-fee USD amount (fixed-point x10^4) into the partner's 80% and
 * Ophis's retained 20%. Exact and conservation-preserving: `ophisUsdFp` is the REMAINDER
 * (`feeUsdFp - partnerUsdFp`), so `partnerUsdFp + ophisUsdFp === feeUsdFp` for EVERY input
 * (no wei/cent is created or lost by the split -- the 80/20 property). `partnerUsdFp` floors,
 * so the partner is never over-credited by a rounding cent.
 */
export function splitFeeUsdFp(feeUsdFp: bigint): { partnerUsdFp: bigint; ophisUsdFp: bigint } {
  if (feeUsdFp <= 0n) return { partnerUsdFp: 0n, ophisUsdFp: 0n };
  const partnerUsdFp = (feeUsdFp * BigInt(PARTNER_FEE_PARTNER_SHARE_BPS)) / 10_000n; // floor
  return { partnerUsdFp, ophisUsdFp: feeUsdFp - partnerUsdFp };
}

/** USD (dollars, may be fractional) -> fixed-point x10^4 bigint (the codebase convention). */
export function usdToFp(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.round(usd * 10_000));
}

/** Fixed-point x10^4 USD bigint -> USD number (dollars) for storage into NUMERIC(20,4). */
export function fpToUsd(fp: bigint): number {
  return Number(fp) / 10_000;
}

/**
 * Convert a fixed-point x10^4 USD amount to WETH wei at `wethUsdPrice` (USD per WETH),
 * byte-for-byte the bigint fixed-point of computeAffiliate / computeOwnFeeAccrual:
 * `wei = usdFp * 1e18 / priceFp` where `priceFp = round(price * 1e4)`, so the *1e4 in
 * `usdFp` cancels and the 1e18 scale never touches float precision. Floors (never
 * over-pays by a sub-wei). Throws on a non-positive / non-finite price (fail-loud --
 * a bad price must never silently size a payout at zero or infinity).
 */
export function usdFpToWei(usdFp: bigint, wethUsdPrice: number): bigint {
  if (!Number.isFinite(wethUsdPrice) || wethUsdPrice <= 0) {
    throw new Error(`usdFpToWei: wethUsdPrice must be a positive finite number; got ${wethUsdPrice}`);
  }
  const priceFp = BigInt(Math.round(wethUsdPrice * 10_000));
  if (priceFp <= 0n) throw new Error('usdFpToWei: wethUsdPrice rounds to zero');
  if (usdFp <= 0n) return 0n;
  return (usdFp * 10n ** 18n) / priceFp;
}
