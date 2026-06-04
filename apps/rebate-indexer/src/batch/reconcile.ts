import { eq, inArray } from 'drizzle-orm';
import { db, schema, sql } from '../db/index.js';
import { getProposalStatus } from './poll.js';
import { alerts } from '../telegram/alerter.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'reconcile' });

// A 'proposed' (queued, awaiting human signature) batch unsigned for longer than
// this is nagged once per nightly run via alerts.batchUnsigned. Signers should act
// well within this window; the nag repeats nightly until the batch is signed.
const UNSIGNED_NAG_DAYS = 3;

export interface ReconcileResult {
  readonly checked: number;
  readonly advancedExecuted: number;
  readonly advancedFailed: number;
  readonly unsignedNagged: number;
  readonly stuckProposing: number;
}

/**
 * Nightly reconciliation of non-terminal Safe rebate batches.
 *
 * After proposing, the batcher attaches an IN-PROCESS waitForExecution() poller
 * (batcher.ts) to advance the row to executed/failed. That poller is a per-process
 * fire-and-forget timer, so it is LOST on any container restart/redeploy — leaving
 * a 'proposed' row stuck at 'proposed' forever even after the Safe tx executed, and
 * a 'proposing' row (a submit was attempted but the hash was never persisted) only
 * resurfacing on the next first-of-month batcher run (~1 month later).
 *
 * This runs EVERY night (not just the 1st), independently of the batcher, to:
 *   - re-poll the Safe Transaction Service for every 'proposed' row and advance it
 *     to executed/failed (heals lost in-process polls across restarts);
 *   - nag (alerts.batchUnsigned) for 'proposed' rows still unsigned after N days;
 *   - surface 'proposing' rows (stuck mid-submit) for manual Safe-queue verification.
 *
 * It NEVER proposes or pays: it only READS the Safe service and writes terminal
 * status / fires alerts. So it is safe to run unconditionally and cannot double-pay
 * — and racing the in-process poller is idempotent (both write the same terminal
 * status from the same on-chain truth). Because it only advances rows OUT of
 * ('proposing','proposed'), a given batch is reconciled (and alerted) at most once.
 */
export async function reconcileBatches(opts: { chainId: number; now?: Date }): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  let advancedExecuted = 0;
  let advancedFailed = 0;
  let unsignedNagged = 0;
  let stuckProposing = 0;

  const open = await db
    .select()
    .from(schema.rebateBatches)
    .where(inArray(schema.rebateBatches.status, ['proposing', 'proposed']));

  for (const row of open) {
    const cycle = row.cycleMonth.slice(0, 7); // 'YYYY-MM'

    // 'proposing': a submit was attempted but no hash was persisted (the hash is
    // written only together with status='proposed'). There is nothing to poll, and
    // a proposal MAY be queued — surface it for manual verification. These are rare.
    if (row.status === 'proposing') {
      stuckProposing++;
      log.error({ cycle, batchId: row.id }, 'batch stuck in proposing; manual Safe-queue verification required');
      void alerts
        .alert(
          'reconcile',
          `Rebate cycle ${cycle} is stuck in 'proposing': a Safe submit was attempted but no hash was persisted, so a proposal may or may not be queued. Verify the Safe queue manually before any retry.`,
        )
        .catch((e) => log.warn({ err: e }, 'stuck-proposing alert failed'));
      continue;
    }

    // status === 'proposed' ⇒ a hash was persisted (single-writer invariant in
    // batcher.ts). Defensive guard in case of manual DB tampering.
    const hash = row.safeProposalHash;
    if (!hash) {
      log.warn({ cycle, batchId: row.id }, "'proposed' row without a safeProposalHash; skipping");
      continue;
    }

    let status;
    try {
      status = await getProposalStatus(opts.chainId, hash);
    } catch (err) {
      // Transient Safe-service / RPC failure — leave the row 'proposed' and retry
      // next run. A per-row failure must not abort reconciliation of the others.
      log.warn({ err, cycle, batchId: row.id }, 'reconcile poll failed; will retry next run');
      continue;
    }

    if (status.executed) {
      const newStatus = status.isSuccessful ? 'executed' : 'failed';
      await db
        .update(schema.rebateBatches)
        .set({ status: newStatus, safeTxHash: status.transactionHash ?? undefined, executedAt: now })
        .where(eq(schema.rebateBatches.id, row.id));

      if (status.isSuccessful) {
        advancedExecuted++;
        const [cnt] = await sql<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM rebate_batch_entries WHERE batch_id = ${row.id} AND weth_amount_wei > 0
        `;
        const count = parseInt(cnt?.n ?? '0', 10);
        const pool = (Number(row.poolWethWei) / 1e18).toFixed(5);
        log.info({ cycle, batchId: row.id, txHash: status.transactionHash }, 'reconcile: batch executed (healed lost in-process poll)');
        void alerts
          .batchExecuted({ cycle, pool, count, txHash: status.transactionHash ?? '' })
          .catch((e) => log.warn({ err: e }, 'batchExecuted alert failed'));
      } else {
        advancedFailed++;
        log.error({ cycle, batchId: row.id, txHash: status.transactionHash }, 'reconcile: batch EXECUTION FAILED on-chain; recipients NOT paid');
        void alerts
          .alert(
            'reconcile',
            `Rebate cycle ${cycle} Safe execution FAILED on-chain (tx ${status.transactionHash}); recipients were NOT paid. Investigate before re-proposing.`,
          )
          .catch((e) => log.warn({ err: e }, 'exec-failed alert failed'));
      }
      continue;
    }

    // Still queued and unsigned — nag if it has aged past the threshold.
    const since = row.proposedAt ?? row.createdAt;
    const ageDays = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
    if (ageDays >= UNSIGNED_NAG_DAYS) {
      unsignedNagged++;
      log.warn({ cycle, batchId: row.id, ageDays }, 'batch unsigned past threshold; nagging');
      void alerts.batchUnsigned(ageDays, cycle).catch((e) => log.warn({ err: e }, 'batchUnsigned alert failed'));
    }
  }

  const result: ReconcileResult = { checked: open.length, advancedExecuted, advancedFailed, unsignedNagged, stuckProposing };
  log.info(result, 'reconcile complete');
  return result;
}
