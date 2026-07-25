import {
  MIN_PARTNER_PAYOUT_USD,
  fpToUsd,
  splitFeeUsdFp,
  usdFpToWei,
  usdToFp,
} from './split.js';

// Pure per-recipient partner-fee accrual for one monthly cycle. NO db / network imports.
// The I/O executor (read the priced trades, screen, dry-run, propose the Safe MultiSend)
// lives in payout.ts; screening + quarantine happen there, so this stays a pure,
// property-testable money computation.

/** A recipient's NEW collected fees this cycle + the balance CARRIED from prior cycles. */
export interface PartnerFeeAccrualInput {
  /** Lowercased 0x recipient (the partner's on-chain WETH payout address). */
  readonly recipient: `0x${string}`;
  /** USD value of the NEW protocol fees collected for this recipient this cycle (Σ fee_usd
   *  over the recipient's not-yet-accounted trades). */
  readonly newFeeUsd: number;
  /** USD the recipient CARRIED from prior cycles (sub-threshold, never paid). Default 0. */
  readonly carriedUsd?: number;
}

/**
 * What one recipient is owed / carries this cycle. `owedUsd = newFeeUsd*0.8 + carriedUsd`.
 * If `owedUsd >= MIN_PARTNER_PAYOUT_USD` the recipient is a PAY candidate (owedWei is the
 * amount to send, carriedUsd resets to 0); otherwise it CARRIES (owedWei is a WETH snapshot
 * for the liability reservation, carriedUsd rolls the full owedUsd forward). Ophis's retained
 * 20% is implicit (never paid, stays in the Safe) -- no row is emitted for it.
 */
export interface PartnerFeeOwed {
  readonly recipient: `0x${string}`;
  /** Total owed this cycle in USD = partner-share of new fees + prior carry. */
  readonly owedUsd: number;
  /** WETH-wei equivalent of owedUsd at `wethUsdPrice`. Present on BOTH kinds (the amount to
   *  pay when `pay`, the reservation snapshot when carried). */
  readonly owedWei: bigint;
  /** true iff owedUsd cleared MIN_PARTNER_PAYOUT_USD (a WETH payout this cycle). */
  readonly pay: boolean;
  /** USD to carry forward: 0 when paying, else the whole owedUsd. */
  readonly carriedUsd: number;
}

/**
 * Compute per-recipient owed for one cycle. Pure + deterministic. For each recipient:
 *   owedUsdFp = splitFeeUsdFp(newFeeUsdFp).partnerUsdFp + carriedUsdFp   (80% + carry)
 *   owedWei   = usdFpToWei(owedUsdFp, price)
 *   pay       = owedUsd >= MIN_PARTNER_PAYOUT_USD
 * Recipients whose owedUsd rounds to 0 (no new fee, no carry) are EXCLUDED. Throws on a
 * duplicate recipient (a caller-contract violation) or a non-positive price (via usdFpToWei).
 *
 * Properties (tests/partnerFees/computePartnerFees.property.test.ts):
 *   - 80/20 exactness: partnerUsdFp + ophisUsdFp == feeUsdFp (no leak).
 *   - owedWei == owedUsdFp * 1e18 / priceFp within 1 wei.
 *   - carry invariant: pay XOR carry (never both); a carried owedUsd rolls forward EXACTLY
 *     and, once it clears the threshold, is paid in full (carry is monotonic until paid).
 */
export function computePartnerFees(
  inputs: readonly PartnerFeeAccrualInput[],
  wethUsdPrice: number,
): PartnerFeeOwed[] {
  const seen = new Set<string>();
  const minFp = usdToFp(MIN_PARTNER_PAYOUT_USD);
  const out: PartnerFeeOwed[] = [];

  for (const inp of inputs) {
    if (seen.has(inp.recipient)) {
      throw new Error(`computePartnerFees: duplicate recipient ${inp.recipient}`);
    }
    seen.add(inp.recipient);

    const newFeeUsdFp = usdToFp(inp.newFeeUsd);
    const carriedUsdFp = usdToFp(inp.carriedUsd ?? 0);
    const { partnerUsdFp } = splitFeeUsdFp(newFeeUsdFp);
    const owedUsdFp = partnerUsdFp + carriedUsdFp;
    if (owedUsdFp <= 0n) continue; // nothing owed (no new fee, no carry)

    const owedWei = usdFpToWei(owedUsdFp, wethUsdPrice);
    const pay = owedUsdFp >= minFp;
    out.push({
      recipient: inp.recipient,
      owedUsd: fpToUsd(owedUsdFp),
      owedWei,
      pay,
      carriedUsd: pay ? 0 : fpToUsd(owedUsdFp),
    });
  }

  return out;
}
