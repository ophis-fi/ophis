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
 * partner-owed WETH still sitting in the Safe. The UNION of two disjoint components:
 *
 *   (a) the carried/quarantined ROLLUP: each recipient's LATEST entry (DISTINCT ON, newest
 *       cycle first) when that latest entry is `carried` or `quarantined`. Latest-only is
 *       correct here because the running carry accumulates INTO the latest entry (an older
 *       carried entry's amount is folded into the newer one via carriedUsd(prev)), so summing
 *       older carried entries too would double-count.
 *
 *   (b) the in-flight PAID amounts: EVERY `paid` entry whose batch is NOT yet `executed`
 *       (its WETH is earmarked in the Safe but has not settled). This must sum ALL such
 *       entries, NOT just the latest per recipient: a recipient paid in a proposed-but-
 *       unexecuted batch who then earns a NEW payable entry next cycle has TWO independent
 *       in-flight payments in the Safe (the newer entry does NOT roll up the older paid one --
 *       a paid entry resets the carry to 0). A latest-only view DROPS the older still-queued
 *       payment and UNDER-reserves it; summing every non-executed paid entry captures it.
 *
 * (a) and (b) are disjoint by status (carried/quarantined vs paid), so their sum never
 * double-counts. Returns 0n when there are no partner batches (so the rebate/affiliate
 * batchers are byte-unaffected until the first partner cycle records).
 */
export async function outstandingPartnerLiabilityWei(): Promise<bigint> {
  const rollup = await carriedQuarantinedLiabilityWei();
  const inflight = await inflightPaidLiabilityWei();
  return rollup + inflight;
}

/**
 * Component (a): the carried/quarantined rollup = Σ owed_wei over each recipient's LATEST
 * entry, but only when that latest entry is `carried` or `quarantined` (a `paid` latest entry
 * consumed the carry into the paid amount, so its carry is 0 and it is captured by (b)
 * instead). Exposed so the partner PROPOSER can reserve its own not-yet-payable obligations
 * symmetrically with how the rebate/affiliate batchers reserve the full liability.
 */
export async function carriedQuarantinedLiabilityWei(): Promise<bigint> {
  const [row] = await sql<{ wei: string }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (e.recipient)
        e.recipient,
        e.status   AS entry_status,
        e.owed_wei
      FROM partner_fee_batch_entries e
      JOIN partner_fee_batches b ON b.id = e.batch_id
      ORDER BY e.recipient, b.cycle_month DESC, b.id DESC
    )
    SELECT COALESCE(SUM(owed_wei), 0)::text AS wei
    FROM latest
    WHERE entry_status IN ('carried', 'quarantined')
  `;
  return BigInt(row?.wei ?? '0');
}

/**
 * Component (b): the in-flight paid amounts = Σ owed_wei over EVERY `paid` entry whose batch
 * is NOT `executed` (the WETH is earmarked in the Safe but has not settled -- computed,
 * proposing, proposed, or a reverted `failed` batch where the atomic MultiSend never moved
 * funds). Sums ALL such entries, not the latest per recipient, so a superseded still-queued
 * payment is never dropped.
 */
export async function inflightPaidLiabilityWei(): Promise<bigint> {
  const [row] = await sql<{ wei: string }[]>`
    SELECT COALESCE(SUM(e.owed_wei), 0)::text AS wei
    FROM partner_fee_batch_entries e
    JOIN partner_fee_batches b ON b.id = e.batch_id
    WHERE e.status = 'paid' AND b.status <> 'executed'
  `;
  return BigInt(row?.wei ?? '0');
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
