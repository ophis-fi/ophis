import { sql } from '../db/index.js';

// Outstanding partner liability -- the MONEY-CORRECTNESS core of partner-fees Phase B.
//
// Partner fees are collected into the SAME Ophis Safe the rebate + affiliate batchers pay
// from (safe/addresses.ts: OPHIS_SAFE_ADDRESS is the "Ophis partner-fee Safe"). Once
// collected (and, per fee-ops, converted to WETH), that WETH inflates the Safe's WETH
// balance. But the partner-owed 80% is NOT Ophis's to distribute: if the rebate DIRECT-mode
// "new fees" delta or the affiliate over-draw guard counted it, the SAME WETH could be paid
// out twice -- once to a partner, once as a rebate/affiliate payout. That is the double-spend
// this module prevents: the rebate distributable and the affiliate available-balance basis
// both SUBTRACT this outstanding liability, and the monthly pipeline runs partner accrual
// FIRST so the liability is up to date before either reads the Safe.
//
// The liability is denominated in WETH wei via each entry's `owed_wei` SNAPSHOT (taken at its
// cycle's WETH/USD price), so the rebate/affiliate batchers reserve it with NO extra price
// fetch on the money path. A carried entry's snapshot can drift slightly from its eventual
// re-priced payout, but the amounts are sub-threshold (< $25) and the reservation is a safety
// margin, not the exact payout -- the exact payout is always the current-price conversion in
// payout.ts. (Accepted approximation, documented in the RUNBOOK.)

/**
 * The WETH (wei) Ophis currently OWES partners and has NOT yet paid out on-chain -- i.e. the
 * partner-owed WETH still sitting in the Safe. Computed over each recipient's LATEST entry
 * (DISTINCT ON, newest cycle first), summing `owed_wei` UNLESS that entry is already
 * `paid` AND its batch `executed` (money left the Safe -> discharged). Everything else is
 * outstanding:
 *   - carried / quarantined (never paid; the collected WETH sits in the Safe);
 *   - paid but the batch is not yet executed (queued in the Safe, not yet signed/executed).
 * Taking only the LATEST entry per recipient avoids double-counting the running carry across
 * the cycles it accumulated through. Returns 0n when there are no partner batches (so the
 * rebate/affiliate batchers are byte-unaffected until the first partner cycle records).
 */
export async function outstandingPartnerLiabilityWei(): Promise<bigint> {
  const [row] = await sql<{ liability: string }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (e.recipient)
        e.recipient,
        e.status        AS entry_status,
        e.owed_wei,
        b.status        AS batch_status
      FROM partner_fee_batch_entries e
      JOIN partner_fee_batches b ON b.id = e.batch_id
      ORDER BY e.recipient, b.cycle_month DESC, b.id DESC
    )
    SELECT COALESCE(SUM(owed_wei), 0)::text AS liability
    FROM latest
    WHERE NOT (entry_status = 'paid' AND batch_status = 'executed')
  `;
  return BigInt(row?.liability ?? '0');
}

/** One recipient's current carried-forward USD balance (sub-threshold, never paid). */
export interface CarriedBalance {
  readonly recipient: `0x${string}`;
  readonly carriedUsd: number;
}

/**
 * Each recipient's CURRENT carry-forward USD balance = the `carried_usd` of their LATEST
 * entry, but ONLY when that latest entry is `carried` or `quarantined` (a `paid` latest
 * entry consumed the carry into the paid amount, so the balance resets to 0 and the
 * recipient does not appear here). This is `carriedUsd(prev)` for the next cycle's
 * computePartnerFees, so a quarantined amount is re-attempted (and never lost) next cycle.
 */
export async function currentCarriedUsdByRecipient(): Promise<CarriedBalance[]> {
  const rows = await sql<{ recipient_hex: string; carried_usd: string }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (e.recipient)
        e.recipient,
        e.status        AS entry_status,
        e.carried_usd
      FROM partner_fee_batch_entries e
      JOIN partner_fee_batches b ON b.id = e.batch_id
      ORDER BY e.recipient, b.cycle_month DESC, b.id DESC
    )
    SELECT encode(recipient, 'hex') AS recipient_hex, carried_usd::text AS carried_usd
    FROM latest
    WHERE entry_status IN ('carried', 'quarantined') AND carried_usd > 0
  `;
  return rows.map((r) => ({
    recipient: `0x${r.recipient_hex}` as `0x${string}`,
    carriedUsd: parseFloat(r.carried_usd),
  }));
}
