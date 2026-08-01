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
 *   (a) the carried/quarantined ROLLUP: Σ owed_wei over every UNFOLDED `carried` /
 *       `quarantined` entry (folded_into_batch_id IS NULL). When a monthly accrual consumes
 *       a carry into a new batch's owed it stamps the source entry's folded_into_batch_id in
 *       the same transaction, so a folded entry's amount lives on in its successor and is
 *       never double-counted -- while an entry quarantined at PROPOSAL time (or carried off a
 *       failed execution) in an OLD batch stays unfolded and keeps counting until an accrual
 *       folds it. (The previous latest-entry-per-recipient heuristic silently DROPPED those
 *       independent per-batch carries when several catch-up batches were in flight.)
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
 * Component (a): the carried/quarantined rollup = Σ owed_wei over every UNFOLDED `carried` /
 * `quarantined` entry. An entry folded into a later accrual (folded_into_batch_id set) is
 * excluded -- its amount lives on in the successor entry -- so the sum never double-counts,
 * while independent unfolded carries across multiple in-flight batches ALL count. Exposed so
 * the partner PROPOSER can reserve its own not-yet-payable obligations symmetrically with how
 * the rebate/affiliate batchers reserve the full liability.
 */
export async function carriedQuarantinedLiabilityWei(): Promise<bigint> {
  const [row] = await sql<{ wei: string }[]>`
    SELECT COALESCE(SUM(owed_wei), 0)::text AS wei
    FROM partner_fee_batch_entries
    WHERE status IN ('carried', 'quarantined') AND folded_into_batch_id IS NULL
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

/**
 * The AUTHORITATIVE USD value of component (a): Σ carried_usd over every unfolded
 * carried/quarantined entry. The partner PROPOSER reserves this converted at the
 * PROPOSAL-TIME price (owed_wei snapshots under-reserve the unchanged USD obligation
 * after a WETH drop, and the proposer can run weeks after accrual); the rebate/affiliate
 * batchers keep the wei-snapshot rollup above, whose drift is bounded by hours.
 */
export async function carriedQuarantinedUsd(): Promise<number> {
  const [row] = await sql<{ usd: string }[]>`
    SELECT COALESCE(SUM(carried_usd), 0)::text AS usd
    FROM partner_fee_batch_entries
    WHERE status IN ('carried', 'quarantined') AND folded_into_batch_id IS NULL
  `;
  return parseFloat(row?.usd ?? '0');
}

/** One recipient's current carried-forward USD balance (sub-threshold, never paid). */
export interface CarriedBalance {
  readonly recipient: `0x${string}`;
  readonly carriedUsd: number;
  /**
   * The batch ids of the exact unfolded entries this balance was summed from. The consuming
   * accrual folds PRECISELY these (batch_id, recipient) rows - never a blanket "everything
   * unfolded" update, which could fold an entry created AFTER this read (e.g. the in-process
   * execution poller concurrently converting an older batch's paid entries to carried) whose
   * amount was never included in the sum, silently deleting it from the ledger.
   */
  readonly sourceBatchIds: readonly number[];
}

/**
 * Each recipient's CURRENT carry-forward USD balance = Σ `carried_usd` over their UNFOLDED
 * `carried` / `quarantined` entries. Summing (not latest-only) is what keeps independent
 * per-batch carries alive: a recipient quarantined at proposal time in TWO catch-up batches
 * has two unfolded entries, and BOTH must fold into the next cycle's owed. Entries already
 * folded into a later accrual are excluded (their amount lives on in the successor entry).
 * This is `carriedUsd(prev)` for the next cycle's computePartnerFees; the accrual that
 * consumes these balances stamps their folded_into_batch_id in the same transaction.
 *
 * `releaseBatchId`: a re-accrual recomputes a still-'computed' batch, whose OWN entries are
 * about to be deleted and whose fold marks are about to be cleared -- so the read must (i)
 * EXCLUDE that batch's own entries and (ii) INCLUDE entries currently folded INTO it, as if
 * the release had already happened (the release itself commits atomically with the recompute).
 */
export async function currentCarriedUsdByRecipient(releaseBatchId?: number): Promise<CarriedBalance[]> {
  const release = releaseBatchId ?? -1;
  // Per-entry rows (not GROUP BY): the caller needs the exact source rows to fold.
  const rows = await sql<{ recipient_hex: string; batch_id: number; carried_usd: string }[]>`
    SELECT encode(recipient, 'hex') AS recipient_hex, batch_id, carried_usd::text AS carried_usd
    FROM partner_fee_batch_entries
    WHERE status IN ('carried', 'quarantined')
      AND (folded_into_batch_id IS NULL OR folded_into_batch_id = ${release})
      AND batch_id <> ${release}
      AND carried_usd > 0
  `;
  const byRecipient = new Map<`0x${string}`, { carriedUsd: number; sourceBatchIds: number[] }>();
  for (const r of rows) {
    const recipient = `0x${r.recipient_hex}` as `0x${string}`;
    const agg = byRecipient.get(recipient) ?? { carriedUsd: 0, sourceBatchIds: [] };
    agg.carriedUsd += parseFloat(r.carried_usd);
    agg.sourceBatchIds.push(r.batch_id);
    byRecipient.set(recipient, agg);
  }
  return [...byRecipient.entries()].map(([recipient, v]) => ({ recipient, ...v }));
}
