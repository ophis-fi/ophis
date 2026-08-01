import { and, eq, inArray, isNull, isNotNull, lt, ne, sql as dsql } from 'drizzle-orm';
import { createPublicClient, http, parseAbi } from 'viem';
import { db, schema, sql } from '../db/index.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';
import { priceTrade } from '../pricer.js';
import { proposeRebateBatch, getNextSafeNonce } from '../batch/propose.js';
import { getProposalStatus, waitForExecution } from '../batch/poll.js';
import { buildEthCallSimulator, isolateBadRecipients, type Transfer } from '../batch/dryRun.js';
import { computePartnerFees } from './computePartnerFees.js';
import { usdFpToWei, usdToFp } from './split.js';
import { currentCarriedUsdByRecipient, carriedQuarantinedLiabilityWei } from './liability.js';
import { isScreenedOut, resolveSanctionsList } from './screening.js';
import { notify, alerts } from '../telegram/alerter.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'partner-fee-payout' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

// partner-fees Phase B monthly payout. DELIBERATELY two-phase (like own-fee), so the ledger
// (and therefore the liability the rebate/affiliate batchers reserve) is never lost to a flag:
//   ACCRUAL (accruePartnerFees) -- ALWAYS runs, flag/key/RPC-INDEPENDENT. Sums each partner's
//     new collected fees, adds the carry, applies the 80% split + $25 threshold + sanctions
//     screening, and records a 'computed' batch + entries (paid/carried/quarantined), stamping
//     the consumed trades so their fees are never counted twice. This is what establishes the
//     outstanding partner liability BEFORE the rebate/affiliate computation in the same cycle.
//   PROPOSAL (proposePartnerFeeBatches) -- gated by PARTNER_FEE_PAYOUT_ENABLED. Dry-runs the
//     paid transfers (quarantining reverting recipients), guards the Safe balance, and proposes
//     the WETH MultiSend on the affiliate Safe rails (decision 18); execution still needs the
//     2-of-3 human signature. Proposes EVERY un-proposed 'computed' batch (current + any
//     back-months a previously-off flag left behind), so nothing owed is ever lost.

/** The partner payout chain + Safe rails (decision 18: the existing affiliate Safe rails). */
export const PARTNER_FEE_CHAIN = 100; // Gnosis, same Ophis Safe as rebate + affiliate

/** Statuses at/after PROPOSAL: a batch here is LOCKED to accrual (never re-accrue / double-pay). */
const PROPOSED_STATUSES = ['proposing', 'proposed', 'executed', 'failed'] as const;
const UNSIGNED_NAG_DAYS = 3;

/**
 * Default-OFF, fail-loud flag gating the partner-fee PAYOUT (Safe proposal). Accrual + the
 * ledger + the liability reservation are flag-INDEPENDENT; only the on-chain proposal is
 * gated, so the deploy stays inert until the operator flips it. Same parser shape as
 * resolveAffiliatePayoutEnabled / resolveOwnFeePayoutEnabled.
 */
export function resolvePartnerFeePayoutEnabled(): boolean {
  const raw = process.env.PARTNER_FEE_PAYOUT_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`PARTNER_FEE_PAYOUT_ENABLED must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

/** The settled (previous) calendar month for a cron firing on the 1st of `now`. YYYY-MM-01. */
function settledLabel(now: Date): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return start.toISOString().slice(0, 10);
}

async function defaultFetchWethUsdPrice(chainId: number): Promise<number> {
  const weth = WETH_BY_CHAIN[chainId];
  if (!weth) throw new Error(`no WETH address for chain ${chainId}`);
  return priceTrade({ tradeUid: `0x${'00'.repeat(56)}` as `0x${string}`, chainId, sellToken: weth, sellAmount: 10n ** 18n });
}

export interface PartnerFeeAccrualDeps {
  readonly now?: Date;
  /** USD per 1 WETH on the payout chain (default: priceTrade of 1 WETH). Injected for tests. */
  readonly fetchWethUsdPrice?: (chainId: number) => Promise<number>;
  /** Sanctions/list screening set (default: resolveSanctionsList()). Injected for tests. */
  readonly sanctions?: ReadonlySet<string>;
}

/**
 * PHASE A -- ACCRUAL. Always runs. Records the partner-owed ledger for the settled month:
 * one 'computed' batch (cycle_month unique) + one entry per recipient with status
 * paid/carried/quarantined, and stamps every consumed trade with the batch id so its fee is
 * never summed into another cycle. Idempotent per cycle:
 *   - LOCKED (proposing/proposed/executed/failed) => already proposed; leave untouched.
 *   - existing 'computed'/'computing'/'no_recipients' => RE-ACCRUE: un-stamp its trades,
 *     delete its entries, and recompute (picks up late-priced trades before proposal).
 *   - none => insert fresh.
 * Returns the batch id + status. Establishes the liability read by the rebate/affiliate
 * batchers, so it MUST run before them each cycle (the cron orders it first).
 */
export async function accruePartnerFees(deps: PartnerFeeAccrualDeps = {}): Promise<{ status: string; batchId?: number }> {
  const now = deps.now ?? new Date();
  const label = settledLabel(now);
  const sanctions = deps.sanctions ?? resolveSanctionsList(); // throws on a malformed list (fail-loud)
  const fetchPrice = deps.fetchWethUsdPrice ?? defaultFetchWethUsdPrice;
  // MONTH-END CUTOFF (P2.8): consume ONLY trades that settled BEFORE the start of `now`'s month
  // (== the end of the settled month). This keeps a first-of-month pre-drain trade (settled
  // 00:00-02:00 on the 1st, before this ~02:00 run) OUT of the previous month's batch. A trade
  // with an un-enriched (NULL) block_timestamp is HELD (not accrued) until the poller enriches
  // it, so a trade is never attributed to the wrong month.
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [existing] = await db.select().from(schema.partnerFeeBatches).where(eq(schema.partnerFeeBatches.cycleMonth, label));
  if (existing && (PROPOSED_STATUSES as readonly string[]).includes(existing.status)) {
    log.info({ cycleMonth: label, status: existing.status }, 'partner-fee batch already proposed; leaving locked (no re-accrual)');
    return { status: 'locked', batchId: existing.id };
  }
  const releaseId = existing?.id ?? -1;

  // COMPLETENESS GATE (fail-loud): an in-scope trade the accrual CANNOT yet account -- an
  // unpriced fee or an un-enriched (NULL) block_timestamp -- means this cycle's owed (and
  // therefore the liability the rebate/affiliate batchers reserve) would silently UNDER-count.
  // Throwing here propagates into the cron's fail-closed guard, which then skips the
  // shared-Safe distribution for the cycle; once the pricer/poller catches up, a pipeline
  // re-trigger re-accrues (idempotent while 'computed') and the cycle completes.
  const [incomplete] = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n
    FROM partner_fee_trades
    WHERE (batch_id IS NULL OR batch_id = ${releaseId})
      AND (block_timestamp IS NULL
           OR (block_timestamp < ${monthEnd.toISOString()} AND fee_usd IS NULL))
  `;
  const incompleteCount = parseInt(incomplete?.n ?? '0', 10);
  if (incompleteCount > 0) {
    throw new Error(
      `partner-fee accrual blocked: ${incompleteCount} in-scope trade(s) are unpriced or missing a ` +
        'block timestamp, so the cycle owed would under-count. Fix the partner-fee pricer/poller ' +
        'backlog and re-trigger the pipeline (accrual re-runs idempotently).',
    );
  }

  // Reads run BEFORE the write transaction (atomic replacement, see below), so a re-accrual
  // must read AS IF the existing batch were already released: its stamped trades count as
  // unbatched and the carries folded into it count as unfolded -- without mutating anything
  // yet. If any read (or the price fetch) fails, the prior ledger is untouched.
  const carried = await currentCarriedUsdByRecipient(existing?.id);
  const carriedByRecipient = new Map(carried.map((c) => [c.recipient, c.carriedUsd]));

  // New fees per recipient = Σ fee_usd over NOT-yet-accounted, PRICED trades (all chains: a
  // recipient is paid once in WETH regardless of which sovereign chain collected the fee).
  const feeRows = await sql<{ recipient_hex: string; fee_usd: string }[]>`
    SELECT encode(recipient, 'hex') AS recipient_hex, SUM(fee_usd)::text AS fee_usd
    FROM partner_fee_trades
    WHERE (batch_id IS NULL OR batch_id = ${releaseId}) AND fee_usd IS NOT NULL
      AND block_timestamp IS NOT NULL AND block_timestamp < ${monthEnd.toISOString()}
    GROUP BY recipient
  `;

  // The accrual set: every recipient with either new fees this cycle OR a standing carry. A
  // pure-carry recipient (carry, no new fees) is INCLUDED so its owed is re-evaluated against
  // the threshold and, once it clears, is paid (its carry does not otherwise re-cross on its own).
  const recipients = new Set<`0x${string}`>();
  const newFeeUsd = new Map<`0x${string}`, number>();
  for (const r of feeRows) {
    const recipient = `0x${r.recipient_hex}` as `0x${string}`;
    recipients.add(recipient);
    newFeeUsd.set(recipient, parseFloat(r.fee_usd));
  }
  for (const c of carried) recipients.add(c.recipient);

  // NOTHING TO ACCRUE (the common default-inert state while PARTNER_FEE_FEED_URLS is unset):
  // record the no_recipients batch WITHOUT fetching a WETH price. An unconditional external
  // price call here would make a transient pricing outage fail the accrual and fail-close the
  // established rebate/affiliate payouts even though no partner obligation exists.
  if (recipients.size === 0) {
    const batchId = await db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(schema.partnerFeeBatchEntries)
          .set({ foldedIntoBatchId: null })
          .where(eq(schema.partnerFeeBatchEntries.foldedIntoBatchId, existing.id));
        await tx.update(schema.partnerFeeTrades).set({ batchId: null }).where(eq(schema.partnerFeeTrades.batchId, existing.id));
        await tx.delete(schema.partnerFeeBatchEntries).where(eq(schema.partnerFeeBatchEntries.batchId, existing.id));
        await tx
          .update(schema.partnerFeeBatches)
          .set({ totalOwedWei: 0n, status: 'no_recipients', updatedAt: now })
          .where(eq(schema.partnerFeeBatches.id, existing.id));
        return existing.id;
      }
      const [b] = await tx
        .insert(schema.partnerFeeBatches)
        .values({ cycleMonth: label, totalOwedWei: 0n, status: 'no_recipients' })
        .returning({ id: schema.partnerFeeBatches.id });
      if (!b) throw new Error('failed to insert partner-fee batch');
      return b.id;
    });
    log.info({ cycleMonth: label, status: 'no_recipients' }, 'partner-fee accrual recorded (nothing to accrue; no price fetched)');
    return { status: 'no_recipients', batchId };
  }

  const wethUsdPrice = await fetchPrice(PARTNER_FEE_CHAIN);
  const owed = computePartnerFees(
    [...recipients].map((recipient) => ({
      recipient,
      newFeeUsd: newFeeUsd.get(recipient) ?? 0,
      carriedUsd: carriedByRecipient.get(recipient) ?? 0,
    })),
    wethUsdPrice,
  );

  // Classify each owed recipient. Sanctions/list screening at payout time (decision 21): a
  // screened recipient is QUARANTINED (never paid; its owed carries forward, re-attempted once
  // cleared). A payable recipient below no screen -> paid; below threshold -> carried.
  const entries = owed.map((o) => {
    const screened = isScreenedOut(o.recipient, sanctions);
    const status = screened ? 'quarantined' : o.pay ? 'paid' : 'carried';
    // paid: carried_usd resets (consumed into owed_wei). carried/quarantined: the whole owedUsd
    // rolls forward via carried_usd (quarantined keeps its owed_wei snapshot for the liability).
    const carriedUsd = status === 'paid' ? 0 : o.owedUsd;
    return { recipient: o.recipient, owedUsd: o.owedUsd, owedWei: o.owedWei, carriedUsd, status };
  });
  const totalPaidWei = entries.filter((e) => e.status === 'paid').reduce((acc, e) => acc + e.owedWei, 0n);
  const status = entries.length > 0 ? 'computed' : 'no_recipients';

  // ATOMIC REPLACEMENT: the release of the existing batch (unfold + un-stamp + delete), the
  // batch upsert, the new entries, the trade stamps, AND the carry folding all commit in ONE
  // transaction. A failure at any point (e.g. a lost DB connection) leaves the PRIOR ledger
  // fully intact -- never a 'computed' batch stripped of its entries, which would silently
  // under-reserve the liability until the next successful accrual.
  const batchId = await db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(schema.partnerFeeBatchEntries)
        .set({ foldedIntoBatchId: null })
        .where(eq(schema.partnerFeeBatchEntries.foldedIntoBatchId, existing.id));
      await tx.update(schema.partnerFeeTrades).set({ batchId: null }).where(eq(schema.partnerFeeTrades.batchId, existing.id));
      await tx.delete(schema.partnerFeeBatchEntries).where(eq(schema.partnerFeeBatchEntries.batchId, existing.id));
    }
    let id: number;
    if (existing) {
      await tx
        .update(schema.partnerFeeBatches)
        .set({ totalOwedWei: totalPaidWei, wethUsdPrice: String(wethUsdPrice), status, updatedAt: now })
        .where(eq(schema.partnerFeeBatches.id, existing.id));
      id = existing.id;
    } else {
      const [b] = await tx
        .insert(schema.partnerFeeBatches)
        .values({ cycleMonth: label, totalOwedWei: totalPaidWei, wethUsdPrice: String(wethUsdPrice), status })
        .returning({ id: schema.partnerFeeBatches.id });
      if (!b) throw new Error('failed to insert partner-fee batch');
      id = b.id;
    }
    if (entries.length > 0) {
      await tx.insert(schema.partnerFeeBatchEntries).values(
        entries.map((e) => ({
          batchId: id,
          recipient: e.recipient,
          owedUsd: e.owedUsd.toFixed(4),
          owedWei: e.owedWei,
          carriedUsd: e.carriedUsd.toFixed(4),
          status: e.status,
        })),
      );
      // Stamp the consumed trades with this batch id so their fee is never re-summed. Only the
      // recipients that produced an entry (a dust recipient with owed rounding to 0 keeps its
      // trades unbatched to accumulate). Runs under the pipeline lock, so no concurrent fetch
      // can slip a trade in between the sum and this stamp. Drizzle so it joins THIS transaction.
      await tx
        .update(schema.partnerFeeTrades)
        .set({ batchId: id })
        .where(
          and(
            isNull(schema.partnerFeeTrades.batchId),
            isNotNull(schema.partnerFeeTrades.feeUsd),
            // Same month-end cutoff as the sum above, so a post-cutoff trade is never STAMPED
            // (consumed) without being credited into this month's owed.
            isNotNull(schema.partnerFeeTrades.blockTimestamp),
            lt(schema.partnerFeeTrades.blockTimestamp, monthEnd),
            inArray(schema.partnerFeeTrades.recipient, entries.map((e) => e.recipient)),
          ),
        );
      // FOLD the consumed carries: every unfolded carried/quarantined entry in an OLDER batch
      // was just read into this batch's owed (the carry read returns exactly the unfolded
      // set), so stamp its folded_into_batch_id. From now on the liability rollup and the
      // next carry read count the SUCCESSOR entry instead -- never both, never neither.
      await tx
        .update(schema.partnerFeeBatchEntries)
        .set({ foldedIntoBatchId: id })
        .where(
          and(
            isNull(schema.partnerFeeBatchEntries.foldedIntoBatchId),
            inArray(schema.partnerFeeBatchEntries.status, ['carried', 'quarantined']),
            ne(schema.partnerFeeBatchEntries.batchId, id),
          ),
        );
    }
    return id;
  });

  log.info(
    {
      cycleMonth: label,
      status,
      recipients: entries.length,
      paid: entries.filter((e) => e.status === 'paid').length,
      carried: entries.filter((e) => e.status === 'carried').length,
      quarantined: entries.filter((e) => e.status === 'quarantined').length,
      totalPaidWei: totalPaidWei.toString(),
    },
    'partner-fee accrual recorded',
  );
  return { status, batchId };
}

export interface PartnerFeeProposeDeps {
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  /** Global dry-run switch (BATCHER_PROPOSE_ENABLED). false => record only, never submit. */
  readonly proposeEnabled: boolean;
  readonly readSafeWethBalanceWei?: (args: { rpcUrl: string; weth: `0x${string}` }) => Promise<bigint>;
  readonly getNextNonce?: (args: { rpcUrl: string }) => Promise<number>;
  readonly propose?: typeof proposeRebateBatch;
  readonly waitForExecution?: typeof waitForExecution;
  /** Injected dry-run simulator (default: on-chain eth_call). */
  readonly simulate?: (batch: readonly Transfer[]) => Promise<{ ok: boolean; reason?: string }>;
  /** Sanctions/list screening set re-checked at PROPOSAL time (default: resolveSanctionsList()). */
  readonly sanctions?: ReadonlySet<string>;
  /** USD per 1 WETH at PROPOSAL time (default: priceTrade of 1 WETH). Injected for tests. */
  readonly fetchWethUsdPrice?: (chainId: number) => Promise<number>;
}

async function defaultReadSafeWethBalanceWei(args: { rpcUrl: string; weth: `0x${string}` }): Promise<bigint> {
  const client = createPublicClient({ transport: http(args.rpcUrl) });
  return client.readContract({ address: args.weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
}

/**
 * WETH (wei) already committed to OPEN Safe proposals on the payout Safe that partner payout
 * must NOT over-draw against: queued (unsigned) PARTNER + REBATE + AFFILIATE proposals. All
 * three pay from the same Ophis Safe, so a new partner proposal must fit within the balance
 * NET of every already-queued tx. (The rebate/affiliate reservation of partner LIABILITY is the
 * mirror image; together they keep all programs from over-drawing the shared Safe.)
 */
async function sumQueuedReservedWei(): Promise<bigint> {
  const [row] = await sql<{ reserved: string }[]>`
    SELECT (
      COALESCE((SELECT SUM(total_owed_wei) FROM partner_fee_batches WHERE status IN ('proposing','proposed')), 0)
      + COALESCE((SELECT SUM(pool_weth_wei) FROM rebate_batches   WHERE status IN ('proposing','proposed')), 0)
      + COALESCE((SELECT SUM(total_owed_wei) FROM affiliate_batches WHERE status IN ('proposing','proposed')), 0)
    )::text AS reserved
  `;
  return BigInt(row?.reserved ?? '0');
}

/**
 * PHASE B -- PROPOSAL. Gated by PARTNER_FEE_PAYOUT_ENABLED (the cron caller checks it).
 * Proposes EVERY un-proposed 'computed' partner batch with owed > 0, OLDEST cycle first
 * (current + any back-months). Per batch: dry-run the paid transfers, QUARANTINE any that
 * revert (their owed carries forward), guard the Safe balance net of queued proposals, and
 * propose the survivors as one WETH MultiSend on the affiliate Safe rails. Each 'computed'
 * batch is proposed AT MOST ONCE (no double-pay). Caller-owned nonce (read once, +1 per
 * submitted proposal) so a same-run catch-up never collides.
 */
export async function proposePartnerFeeBatches(deps: PartnerFeeProposeDeps): Promise<{ checked: number; proposed: number; blocked: number; dryRun?: boolean }> {
  const weth = WETH_BY_CHAIN[PARTNER_FEE_CHAIN];
  if (!weth) throw new Error('no WETH address for the partner payout chain');

  const computed = await db
    .select()
    .from(schema.partnerFeeBatches)
    .where(and(eq(schema.partnerFeeBatches.status, 'computed')))
    .orderBy(schema.partnerFeeBatches.cycleMonth);
  const payable = computed.filter((b) => b.totalOwedWei > 0n);
  if (payable.length === 0) return { checked: 0, proposed: 0, blocked: 0 };

  // PROPOSAL-TIME REPRICE (RUNBOOK contract: the payout is the current-price conversion of
  // the USD obligation). A batch's entry owed_wei is the ACCRUAL-time snapshot; a batch that
  // waited behind the payout flag, an underfunded Safe, or a pre-submit failure would
  // otherwise send WETH at a stale price -- e.g. an $80 entry computed at $2,000/WETH still
  // sends 0.04 WETH after the price halves, doubling the real payout. Fetched ONLY when
  // there is something to propose (no idle external dependency).
  const wethUsdPrice = await (deps.fetchWethUsdPrice ?? defaultFetchWethUsdPrice)(PARTNER_FEE_CHAIN);

  // NOTE (P2.6): the dry-run (proposeEnabled=false) runs the FULL plan -- re-screen, dry-run
  // simulate, quarantine, AND the Safe-balance over-draw check -- and skips ONLY the Safe
  // submission, so an operator's dry-run validates exactly what a real run would do. DB writes
  // (quarantine, total updates, proposal) happen only when `persist` (proposeEnabled) is true.
  const persist = deps.proposeEnabled;
  const screen = deps.sanctions ?? resolveSanctionsList(); // throws on a malformed list (fail-loud)
  const readBalance = deps.readSafeWethBalanceWei ?? defaultReadSafeWethBalanceWei;
  const balance = await readBalance({ rpcUrl: deps.rpcUrl, weth });
  // Reserve BOTH (i) other programs' queued (unsigned) proposals AND the partner program's own
  // already-queued paid proposals -- `sumQueuedReservedWei` -- AND (ii) the partner program's own
  // carried/quarantined liability -- `carriedQuarantinedLiabilityWei` -- so proposing a fresh
  // paid batch under an underfunded Safe can never leave a carried/quarantined obligation
  // unfunded. This mirrors what the rebate/affiliate batchers reserve (the full partner
  // liability), so R + P + A <= B holds across all three consumers. (Codex symmetric-reservation)
  const queuedReserved = await sumQueuedReservedWei();
  const ownCarriedQuarantined = await carriedQuarantinedLiabilityWei();
  const reserved = queuedReserved + ownCarriedQuarantined;
  let remaining = balance > reserved ? balance - reserved : 0n;
  if (reserved > 0n) {
    log.info(
      { balanceWei: balance.toString(), queuedReservedWei: queuedReserved.toString(), ownCarriedQuarantinedWei: ownCarriedQuarantined.toString(), remainingWei: remaining.toString() },
      'partner-fee propose: reserved queued partner/rebate/affiliate proposals + own carried/quarantined liability',
    );
  }

  const simulate = deps.simulate ?? buildEthCallSimulator({ chainId: PARTNER_FEE_CHAIN, rpcUrl: deps.rpcUrl });
  const readNonce = deps.getNextNonce ?? (async () => getNextSafeNonce(PARTNER_FEE_CHAIN, OPHIS_SAFE_ADDRESS));
  let nextNonce: number | undefined;
  let proposed = 0;
  let blocked = 0;

  // Quarantine one recipient's entry (persisted only in a real run): carried_usd rolls the owed
  // forward so a cleared recipient is re-attempted next cycle and the amount is never lost.
  async function quarantine(batchId: number, to: `0x${string}`): Promise<void> {
    if (!persist) return;
    await sql`
      UPDATE partner_fee_batch_entries SET status = 'quarantined', carried_usd = owed_usd
      WHERE batch_id = ${batchId} AND recipient = decode(${to.slice(2)}, 'hex')
    `;
  }

  for (const batch of payable) {
    const cycle = batch.cycleMonth.slice(0, 7);
    // Reprice each entry's USD obligation at the proposal-time rate (see the fetch above).
    // owed_usd is authoritative; owed_wei was only the accrual-time reservation snapshot.
    const paidEntries = await sql<{ recipient_hex: string; owed_usd: string }[]>`
      SELECT encode(recipient, 'hex') AS recipient_hex, owed_usd::text AS owed_usd
      FROM partner_fee_batch_entries WHERE batch_id = ${batch.id} AND status = 'paid'
    `;
    let transfers: Transfer[] = paidEntries.map((e) => ({
      to: `0x${e.recipient_hex}` as `0x${string}`,
      amount: usdFpToWei(usdToFp(parseFloat(e.owed_usd)), wethUsdPrice),
    }));
    if (transfers.length === 0) continue;

    // P2.5 RE-SCREEN at proposal time: the sanctions/list may have changed since accrual, so a
    // newly-blocked recipient must be quarantined BEFORE the simulate/submit, never paid.
    const sanctioned = transfers.filter((t) => isScreenedOut(t.to, screen));
    if (sanctioned.length > 0) {
      for (const s of sanctioned) await quarantine(batch.id, s.to);
      transfers = transfers.filter((t) => !isScreenedOut(t.to, screen));
      log.warn({ cycle, sanctionedCount: sanctioned.length }, 'partner-fee: recipients screened out at proposal (sanctions/list); owed carries forward');
      await alerts.alert('partner-fee-payout', `Partner-fee ${cycle}: ${sanctioned.length} recipient(s) SCREENED OUT at proposal (sanctions/list changed since accrual); owed carries forward. Investigate.`).catch(() => {});
    }

    // Dry-run + quarantine (runs in BOTH modes; mirrors the rebate batcher): a recipient whose
    // WETH.transfer reverts is QUARANTINED, never proposed.
    const { good, bad } = await isolateBadRecipients(transfers, simulate);
    if (bad.length > 0) {
      for (const b of bad) await quarantine(batch.id, b.to);
      const quarantinedWei = bad.reduce((acc, t) => acc + t.amount, 0n);
      log.warn({ cycle, badCount: bad.length, quarantinedWei: quarantinedWei.toString(), persist }, 'partner-fee: recipients quarantined at dry-run; owed carries forward');
      await alerts.alert('partner-fee-payout', `Partner-fee ${cycle}: ${bad.length} recipient(s) QUARANTINED (transfer reverted at dry-run); their owed carries forward and is re-attempted next cycle. Investigate.`).catch(() => {});
      transfers = good;
    }
    // Persist the survivors' REPRICED owed_wei + the batch total in one transaction (real run
    // only), so the ledger, the liability reservation, and the Safe MultiSend all agree on the
    // proposal-time conversion, and paid_wei (set = owed_wei on execution) records what was
    // actually sent. Runs regardless of quarantines: the reprice alone changes the amounts.
    if (persist) {
      const newTotal = transfers.reduce((acc, t) => acc + t.amount, 0n);
      await db.transaction(async (tx) => {
        for (const t of transfers) {
          await tx
            .update(schema.partnerFeeBatchEntries)
            .set({ owedWei: t.amount })
            .where(
              and(
                eq(schema.partnerFeeBatchEntries.batchId, batch.id),
                eq(schema.partnerFeeBatchEntries.recipient, t.to),
              ),
            );
        }
        await tx.update(schema.partnerFeeBatches).set({ totalOwedWei: newTotal, updatedAt: new Date() }).where(eq(schema.partnerFeeBatches.id, batch.id));
      });
    }
    if (transfers.length === 0) {
      // Everything quarantined: nothing to propose. Leave 'computed' so a cleared recipient
      // re-proposes next cycle (the entries already carry). Not a double-pay hazard (no tx).
      log.warn({ cycle, batchId: batch.id }, 'partner-fee batch fully quarantined; nothing proposed');
      continue;
    }

    const owedWei = transfers.reduce((acc, t) => acc + t.amount, 0n);
    if (owedWei > remaining) {
      blocked++;
      log.error({ cycle, batchId: batch.id, owedWei: owedWei.toString(), remainingWei: remaining.toString() }, 'partner-fee batch BLOCKED (owed exceeds available Safe WETH)');
      await alerts.alert('partner-fee-payout', `Partner-fee batch ${cycle} BLOCKED: owed ${owedWei} > available Safe WETH ${remaining} wei (net of queued proposals). Left 'computed'; fund the Safe and it proposes next run.`).catch(() => {});
      continue;
    }

    // DRY-RUN: everything above (screen + simulate + balance check) ran for operator validation;
    // skip ONLY the Safe submission. Model the reservation so later batches see the same picture.
    if (!persist) {
      remaining -= owedWei;
      log.info({ cycle, batchId: batch.id, owedWei: owedWei.toString(), recipients: transfers.length }, 'partner-fee dry-run: would propose (Safe submission skipped)');
      continue;
    }

    if (nextNonce === undefined) nextNonce = await readNonce({ rpcUrl: deps.rpcUrl });
    const outcome = await proposeComputedBatch(batch, transfers, deps, nextNonce);
    if (outcome === 'proposed') {
      proposed++;
      remaining -= owedWei;
      nextNonce++;
    } else if (outcome === 'attempted') {
      // AMBIGUOUS: the Safe service call failed AFTER the submit was sent, so we do not know
      // whether this nonce was accepted. STOP the catch-up here -- proposing later batches on
      // a guessed next nonce either queues them above a hole (unexecutable) or stacks onto an
      // unverified queue. The alert already fired; reconcile/manual verification resolves the
      // batch, and the nightly proposal retry picks the remaining batches up next run.
      log.error({ cycle, batchId: batch.id }, 'partner-fee catch-up STOPPED after an ambiguous Safe submission; remaining batches retry next run');
      break;
    }
  }
  return { checked: payable.length, proposed, blocked, dryRun: persist ? undefined : true };
}

async function proposeComputedBatch(
  batch: { id: number; cycleMonth: string; totalOwedWei: bigint },
  transfers: readonly Transfer[],
  deps: PartnerFeeProposeDeps,
  nonce: number,
): Promise<'proposed' | 'attempted' | 'presubmit-failed'> {
  const cycle = batch.cycleMonth.slice(0, 7);
  const propose = deps.propose ?? proposeRebateBatch;
  let submitAttempted = false;
  let safeTxHash: `0x${string}`;
  try {
    ({ safeTxHash } = await propose({
      chainId: PARTNER_FEE_CHAIN,
      rpcUrl: deps.rpcUrl,
      proposerPrivateKey: deps.proposerPrivateKey,
      transfers: transfers.map((t) => ({ to: t.to, amount: t.amount })),
      nonce,
      onBeforeSubmit: async () => {
        await db.update(schema.partnerFeeBatches).set({ status: 'proposing', updatedAt: new Date() }).where(eq(schema.partnerFeeBatches.id, batch.id));
        submitAttempted = true;
      },
    }));
  } catch (err) {
    if (submitAttempted) {
      log.error({ err, batchId: batch.id, cycle }, 'partner-fee submit failed after send; left proposing for manual verification');
      await alerts.alert('partner-fee-payout', `Partner-fee ${cycle} Safe submit FAILED after send. A proposal may or may not exist -- verify the Safe queue before retrying.`).catch(() => {});
      return 'attempted';
    }
    log.error({ err, batchId: batch.id, cycle }, 'partner-fee pre-submit failed; left computed for auto-retry');
    await alerts.alert('partner-fee-payout', `Partner-fee ${cycle} failed BEFORE the Safe submit (no proposal queued); left 'computed' to retry next run.`).catch(() => {});
    return 'presubmit-failed';
  }

  await db.update(schema.partnerFeeBatches).set({ status: 'proposed', safeProposalHash: safeTxHash, updatedAt: new Date() }).where(eq(schema.partnerFeeBatches.id, batch.id));

  const wait = deps.waitForExecution ?? waitForExecution;
  wait({ chainId: PARTNER_FEE_CHAIN, safeTxHash })
    .then(async (r) => {
      if (r.executed) {
        await finalizeExecutedPartnerBatch(batch.id, { isSuccessful: r.isSuccessful === true, transactionHash: r.transactionHash });
      }
    })
    .catch((err) => log.error({ err, batchId: batch.id }, 'partner-fee polling failed'));

  const proposedWei = transfers.reduce((acc, t) => acc + t.amount, 0n);
  await notify(`Partner-fee payout ${cycle} proposed: ${(Number(proposedWei) / 1e18).toFixed(5)} WETH across ${transfers.length} recipient(s). Awaiting 2-of-3 signature.`);
  log.info({ batchId: batch.id, safeTxHash, nonce, recipients: transfers.length }, 'partner-fee batch proposed');
  return 'proposed';
}

/**
 * Commit a batch's TERMINAL state and its entries' settlement/carry state in ONE transaction.
 * Success: status 'executed' + every 'paid' entry gets paid_wei = owed_wei (atomic MultiSend =
 * all paid). Failure (reverted): status 'failed' + the 'paid' entries convert to 'carried'
 * (carried_usd = owed_usd) so the next monthly accrual re-attempts them (P2.7) -- the reverted
 * MultiSend moved NO funds, so the amount is never lost; the failed batch's cycle stays closed
 * and the carry lands in the next cycle.
 *
 * Atomicity matters: with two independent statements, a crash between them left a terminal
 * batch whose entries were never settled/carried -- no longer selected by reconcile, so a
 * successful payment permanently lacked paid_wei, and a reverted one stayed 'paid' in a
 * 'failed' batch: reserved forever, re-attempted never.
 */
async function finalizeExecutedPartnerBatch(
  batchId: number,
  r: { isSuccessful: boolean; transactionHash?: string | null },
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.partnerFeeBatches)
      .set({ status: r.isSuccessful ? 'executed' : 'failed', safeTxHash: (r.transactionHash as `0x${string}` | null) ?? undefined, updatedAt: now })
      .where(eq(schema.partnerFeeBatches.id, batchId));
    if (r.isSuccessful) {
      await tx
        .update(schema.partnerFeeBatchEntries)
        .set({ paidWei: dsql`${schema.partnerFeeBatchEntries.owedWei}` })
        .where(and(eq(schema.partnerFeeBatchEntries.batchId, batchId), eq(schema.partnerFeeBatchEntries.status, 'paid')));
    } else {
      await tx
        .update(schema.partnerFeeBatchEntries)
        .set({ status: 'carried', carriedUsd: dsql`${schema.partnerFeeBatchEntries.owedUsd}` })
        .where(and(eq(schema.partnerFeeBatchEntries.batchId, batchId), eq(schema.partnerFeeBatchEntries.status, 'paid')));
    }
  });
}

/**
 * Nightly reconciliation of non-terminal partner-fee batches -- the mirror of
 * reconcileAffiliateBatches for the SEPARATE partner tables. Heals 'proposed' rows whose
 * in-process finality poller was lost on a restart, marks entries paid on success, surfaces
 * stuck 'proposing' rows, and nags unsigned proposals. READ-ONLY against the Safe service, so
 * it never double-pays and is safe to run unconditionally.
 */
export async function reconcilePartnerFeeBatches(opts: { now?: Date } = {}): Promise<{ checked: number; advancedExecuted: number; advancedFailed: number }> {
  const now = opts.now ?? new Date();
  let advancedExecuted = 0;
  let advancedFailed = 0;

  const open = await db.select().from(schema.partnerFeeBatches).where(inArray(schema.partnerFeeBatches.status, ['proposing', 'proposed']));
  for (const row of open) {
    const cycle = row.cycleMonth.slice(0, 7);
    if (row.status === 'proposing') {
      log.error({ cycle, batchId: row.id }, 'partner-fee batch stuck in proposing; manual Safe-queue verification required');
      await alerts.alert('partner-fee-reconcile', `Partner-fee ${cycle} is stuck in 'proposing'; a Safe submit was attempted but no hash persisted. Verify the Safe queue before any retry.`).catch(() => {});
      continue;
    }
    const hash = row.safeProposalHash;
    if (!hash) {
      log.warn({ cycle, batchId: row.id }, "partner-fee 'proposed' row without a hash; skipping");
      continue;
    }
    let status;
    try {
      status = await getProposalStatus(PARTNER_FEE_CHAIN, hash);
    } catch (err) {
      log.warn({ err, cycle, batchId: row.id }, 'partner-fee reconcile poll failed; retry next run');
      continue;
    }
    if (status.executed) {
      // Terminal batch status + entry settlement/carry state commit in ONE transaction
      // (finalizeExecutedPartnerBatch) so a crash can never strand a terminal batch with
      // unsettled entries.
      await finalizeExecutedPartnerBatch(row.id, { isSuccessful: status.isSuccessful === true, transactionHash: status.transactionHash }, now);
      if (status.isSuccessful) {
        advancedExecuted++;
        await alerts.alert('partner-fee-reconcile', `Partner-fee ${cycle} EXECUTED on-chain (tx ${status.transactionHash}).`).catch(() => {});
      } else {
        advancedFailed++;
        log.error({ cycle, batchId: row.id, txHash: status.transactionHash }, 'partner-fee batch EXECUTION FAILED on-chain; recipients NOT paid; owed carried forward for next cycle');
        await alerts.alert('partner-fee-reconcile', `Partner-fee ${cycle} Safe execution FAILED on-chain (tx ${status.transactionHash}); recipients were NOT paid. Their owed has been carried forward and will be re-attempted next cycle.`).catch(() => {});
      }
      continue;
    }
    const ageDays = Math.floor((now.getTime() - row.createdAt.getTime()) / 86_400_000);
    if (ageDays >= UNSIGNED_NAG_DAYS) {
      log.warn({ cycle, batchId: row.id, ageDays }, 'partner-fee batch unsigned past threshold; nagging');
      await alerts.alert('partner-fee-reconcile', `Partner-fee ${cycle} has been awaiting signature for ${ageDays} days. Sign it in the Safe queue.`).catch(() => {});
    }
  }
  return { checked: open.length, advancedExecuted, advancedFailed };
}
