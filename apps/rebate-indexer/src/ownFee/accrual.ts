import { sql } from '../db/index.js';
import { SOVEREIGN_OWN_FEE_RECIPIENTS, isPayableOwnFeeRecipient } from './recipients.js';

// Per-recipient SOVEREIGN own-fee accrual for one cycle month + chain.
//
// An integrator's OWN fee (a stacked non-Ophis flat-Volume partnerFee entry) is decoded
// per trade into trades.own_fee_bps / own_fee_recipient (migration 0014). On Optimism
// (10) / Unichain (130) the fee is swept to the Ophis Safe, and this accrual computes
// what each ALLOWLISTED recipient is owed back. Own-fee is 100% to the recipient: NO
// fee-share, NO keepFraction (unlike the affiliate accrual, which pays only a share of
// the fee Ophis keeps). The USD->WETH-wei conversion is byte-for-byte the bigint
// fixed-point of computeAffiliate (owedWei = owedUsdFp * 1e18 / priceFp), never float.

/** What one allowlisted own-fee recipient is owed for a cycle. owedWei is WETH paid. */
export interface OwnFeeOwed {
  /** Lowercased 0x recipient == the own-fee recipient == the on-chain payout address. */
  readonly recipient: `0x${string}`;
  readonly owedUsd: number;
  readonly owedWei: bigint;
}

/**
 * Accrue owed WETH per allowlisted own-fee recipient for [monthStart, monthEnd) on one
 * sovereign chain. Reads SUM(value_usd * own_fee_bps) grouped by recipient over
 * fee-verified, priced trades in the window, FILTERS to recipients in the fail-closed
 * allowlist (also excluding the Ophis Safe + zero address), then converts USD -> WETH
 * wei with the same bigint fixed-point as computeAffiliate. Excludes owed <= 0. Returns
 * one entry per allowlisted recipient.
 */
export async function computeOwnFeeAccrual(
  chainId: number,
  monthStart: Date,
  monthEnd: Date,
  wethUsdPrice: number,
  allowlist: ReadonlySet<string> = SOVEREIGN_OWN_FEE_RECIPIENTS,
): Promise<OwnFeeOwed[]> {
  if (!Number.isFinite(wethUsdPrice) || wethUsdPrice <= 0) {
    throw new Error(`computeOwnFeeAccrual: wethUsdPrice must be a positive finite number; got ${wethUsdPrice}`);
  }
  // price * 1e4 as bigint, so the * 1e4 in owedUsdFp cancels in the wei division
  // (identical fixed-point to computeAffiliate).
  const priceFp = BigInt(Math.round(wethUsdPrice * 10_000));
  if (priceFp <= 0n) throw new Error('computeOwnFeeAccrual: wethUsdPrice rounds to zero');

  // Own-fee base per recipient = SUM(value_usd * own_fee_bps) (USD * bps). The predicates
  // mirror the earnings own-fee arm: fee_verified guards catalog-only discovery rows and
  // value_usd IS NOT NULL keeps unpriced trades out. Grouped by own_fee_recipient so each
  // recipient is one row; the in-code allowlist filter is applied below.
  const rows = await sql<{ recipient_hex: string; fee_base: string }[]>`
    SELECT
      encode(own_fee_recipient, 'hex')   AS recipient_hex,
      SUM(value_usd * own_fee_bps)::text AS fee_base
    FROM trades
    WHERE chain_id = ${chainId}
      AND own_fee_bps IS NOT NULL
      AND own_fee_recipient IS NOT NULL
      AND fee_verified = true
      AND value_usd IS NOT NULL
      AND block_timestamp >= ${monthStart.toISOString()}
      AND block_timestamp <  ${monthEnd.toISOString()}
    GROUP BY own_fee_recipient
  `;

  const out: OwnFeeOwed[] = [];
  for (const r of rows) {
    const recipient = `0x${r.recipient_hex}`.toLowerCase() as `0x${string}`;
    // Fail-closed allowlist filter (also excludes the Ophis Safe + zero address).
    if (!isPayableOwnFeeRecipient(recipient, allowlist)) continue;
    const feeBase = parseFloat(r.fee_base); // USD * bps
    if (!Number.isFinite(feeBase) || feeBase <= 0) continue;
    const owedUsd = feeBase / 10_000;
    // owedUsdFp = round(owedUsd * 1e4); owedWei = owedUsdFp * 1e18 / priceFp (bigint,
    // never float) -- byte-for-byte the computeAffiliate conversion.
    const owedUsdFp = BigInt(Math.round(owedUsd * 10_000));
    const owedWei = (owedUsdFp * 10n ** 18n) / priceFp;
    if (owedWei <= 0n) continue;
    out.push({ recipient, owedUsd, owedWei });
  }
  return out;
}
