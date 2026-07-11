import { eq } from 'drizzle-orm';
import { createPublicClient, http, parseAbi } from 'viem';
import { db, schema, sql } from '../db/index.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';
import { priceTrade } from '../pricer.js';
import { proposeRebateBatch } from '../batch/propose.js';
import { waitForExecution } from '../batch/poll.js';
import { buildAffiliateReferrers } from './accrual.js';
import { computeAffiliate } from './computeAffiliate.js';
import { planAffiliatePayout } from './payoutPlan.js';
import { notify, alerts } from '../telegram/alerter.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'affiliate-payout' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const GNOSIS = 100;

export { resolveAffiliatePayoutEnabled, planAffiliatePayout } from './payoutPlan.js';

/** The settled (previous) calendar month for a cron firing on the 1st of `now`. */
function settledWindow(now: Date): { start: Date; end: Date; label: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end, label: `${start.toISOString().slice(0, 10)}` }; // YYYY-MM-01
}

export interface AffiliatePayoutDeps {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly proposeEnabled: boolean;
  readonly now?: Date;
}

/**
 * Monthly affiliate payout. Flag-gated (resolveAffiliatePayoutEnabled) by the cron
 * caller. Computes owed for the settled month, guards against over-drawing the Safe,
 * records a SEPARATE affiliate_batches row + entries (never mixed with rebates), and
 * proposes one WETH MultiSend to the same Safe (gets nonce+1 after the rebate batch).
 * Execution still requires the 2-of-3 human signature. Idempotent per cycle month.
 */
export async function runAffiliatePayout(deps: AffiliatePayoutDeps): Promise<{ status: string; batchId?: number }> {
  const now = deps.now ?? new Date();
  const { start, end, label } = settledWindow(now);

  // Idempotency: one affiliate batch per cycle. If a row already exists for this
  // cycle (any status), do not re-propose — surface + skip (a stuck row is healed
  // by reconcileAffiliateBatches, not by re-proposing here, to avoid double-pay).
  const [existing] = await db.select().from(schema.affiliateBatches).where(eq(schema.affiliateBatches.cycleMonth, label));
  if (existing) {
    log.info({ cycleMonth: label, status: existing.status }, 'affiliate batch already exists for cycle; skipping');
    return { status: 'exists', batchId: existing.id };
  }

  const weth = WETH_BY_CHAIN[GNOSIS];
  if (!weth) throw new Error('no WETH address for Gnosis');
  const client = createPublicClient({ transport: http(deps.rpcUrl) });
  const safeBalanceWei = await client.readContract({ address: weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
  const wethUsdPrice = await priceTrade({ tradeUid: `0x${'00'.repeat(56)}` as `0x${string}`, chainId: GNOSIS, sellToken: weth, sellAmount: 10n ** 18n });

  const referrers = await buildAffiliateReferrers(start, end);
  const owed = computeAffiliate(referrers, wethUsdPrice);

  // RESERVE the WETH committed to EVERY still-pending rebate proposal for the
  // double-spend guard — not just the latest cycle's batch. Affiliate is paid from
  // the SAME Safe as rebates, so any rebate batch still 'proposing'/'proposed'
  // (queued, not yet signed/executed) still holds its pool WETH in the Safe. SUMming
  // only the latest row would ignore an earlier back-month rebate proposal that is
  // still unsigned, letting affiliate + rebates together over-draw the Safe. Mirrors
  // the own-fee reservation (ownFee/payout.ts). (money-safety)
  const [rb] = await sql<{ pool: string }[]>`SELECT COALESCE(SUM(pool_weth_wei), 0)::text AS pool FROM rebate_batches WHERE status IN ('proposing', 'proposed')`;
  const rebatePoolWei = rb ? BigInt(rb.pool) : 0n;

  const plan = planAffiliatePayout(owed, safeBalanceWei, rebatePoolWei);

  if (plan.blocked) {
    log.error({ cycleMonth: label, totalOwedWei: plan.totalOwedWei.toString(), rebatePoolWei: rebatePoolWei.toString(), safeBalanceWei: safeBalanceWei.toString() }, 'affiliate payout BLOCKED');
    await alerts.alert('affiliate-payout', `Affiliate payout ${label} BLOCKED: ${plan.reason}. rebate ${rebatePoolWei} + affiliate ${plan.totalOwedWei} > Safe ${safeBalanceWei} wei. No proposal made; investigate.`).catch(() => {});
    return { status: 'blocked' };
  }
  if (plan.transfers.length === 0) {
    const [row] = await db.insert(schema.affiliateBatches).values({ cycleMonth: label, totalOwedWei: 0n, wethUsdPrice: String(wethUsdPrice), status: 'no_recipients' }).returning();
    log.info({ cycleMonth: label }, 'affiliate payout: no recipients');
    return { status: 'no_recipients', batchId: row?.id };
  }

  // Record the batch (computing) + per-referrer entries — SEPARATE from rebate tables.
  const [batch] = await db.insert(schema.affiliateBatches).values({
    cycleMonth: label,
    totalOwedWei: plan.totalOwedWei,
    wethUsdPrice: String(wethUsdPrice),
    status: 'computing',
  }).returning();
  if (!batch) throw new Error('failed to insert affiliate batch');
  // The entry is keyed on the referrer IDENTITY (t.referrerWallet), NOT the on-chain
  // recipient (t.to) — the two differ when a payout_wallet redirect is set.
  await db.insert(schema.affiliateBatchEntries).values(
    plan.transfers.map((t) => ({
      batchId: batch.id,
      referrerWallet: t.referrerWallet,
      kind: t.kind,
      referredVolumeUsd: String(t.referredVolumeUsd),
      owedWei: t.amount,
      status: 'pending',
    })),
  );

  if (!deps.proposeEnabled) {
    log.info({ batchId: batch.id, recipients: plan.transfers.length }, 'affiliate dry-run only, not proposing');
    return { status: 'computing', batchId: batch.id };
  }

  let submitAttempted = false;
  let safeTxHash: `0x${string}`;
  try {
    ({ safeTxHash } = await proposeRebateBatch({
      chainId: deps.chainId,
      rpcUrl: deps.rpcUrl,
      proposerPrivateKey: deps.proposerPrivateKey,
      transfers: plan.transfers.map((t) => ({ to: t.to, amount: t.amount })),
      onBeforeSubmit: async () => {
        await db.update(schema.affiliateBatches).set({ status: 'proposing', updatedAt: new Date() }).where(eq(schema.affiliateBatches.id, batch.id));
        submitAttempted = true;
      },
    }));
  } catch (err) {
    if (submitAttempted) {
      log.error({ err, batchId: batch.id, cycleMonth: label }, 'affiliate submit failed after send; left proposing for manual verification');
      await alerts.alert('affiliate-payout', `Affiliate cycle ${label} Safe submit FAILED after send. A proposal may or may not exist — verify the Safe queue before retrying.`).catch(() => {});
    } else {
      log.error({ err, batchId: batch.id, cycleMonth: label }, 'affiliate pre-submit failed; left computing');
      await alerts.alert('affiliate-payout', `Affiliate cycle ${label} failed BEFORE the Safe submit (no proposal queued). Resolve and re-run.`).catch(() => {});
    }
    throw err;
  }

  await db.update(schema.affiliateBatches).set({ status: 'proposed', safeProposalHash: safeTxHash, updatedAt: new Date() }).where(eq(schema.affiliateBatches.id, batch.id));

  waitForExecution({ chainId: deps.chainId, safeTxHash }).then(async (r) => {
    if (r.executed) {
      await db.update(schema.affiliateBatches).set({ status: r.isSuccessful ? 'executed' : 'failed', safeTxHash: r.transactionHash ?? undefined, updatedAt: new Date() }).where(eq(schema.affiliateBatches.id, batch.id));
      if (r.isSuccessful) await markAffiliateEntriesPaid(batch.id);
    }
  }).catch((err) => log.error({ err, batchId: batch.id }, 'affiliate polling failed'));

  await notify(`💸 Affiliate payout ${label} proposed: ${(Number(plan.totalOwedWei) / 1e18).toFixed(5)} WETH across ${plan.transfers.length} referrer(s). Awaiting 2-of-3 signature.`);
  log.info({ batchId: batch.id, safeTxHash, recipients: plan.transfers.length }, 'affiliate batch proposed');
  return { status: 'proposed', batchId: batch.id };
}

/** Mark all entries of an executed affiliate batch as paid (atomic MultiSend = all paid). */
async function markAffiliateEntriesPaid(batchId: number): Promise<void> {
  await sql`UPDATE affiliate_batch_entries SET paid_wei = owed_wei, status = 'paid' WHERE batch_id = ${batchId}`;
}

const UNSIGNED_NAG_DAYS = 3;

/**
 * Nightly reconciliation of non-terminal affiliate batches — the mirror of
 * reconcileBatches for the SEPARATE affiliate tables. Heals 'proposed' rows whose
 * in-process finality poller was lost on a restart, marks entries paid on success,
 * surfaces 'proposing' rows for manual verification, and nags unsigned proposals.
 * READ-ONLY against the Safe service: it never proposes or pays, so it cannot
 * double-pay and is safe to run unconditionally.
 */
export async function reconcileAffiliateBatches(opts: { chainId: number; now?: Date }): Promise<{ checked: number; advancedExecuted: number; advancedFailed: number }> {
  const { db, schema } = await import('../db/index.js');
  const { getProposalStatus } = await import('../batch/poll.js');
  const { inArray, eq } = await import('drizzle-orm');
  const now = opts.now ?? new Date();
  let advancedExecuted = 0;
  let advancedFailed = 0;

  const open = await db.select().from(schema.affiliateBatches).where(inArray(schema.affiliateBatches.status, ['proposing', 'proposed']));
  for (const row of open) {
    const cycle = row.cycleMonth.slice(0, 7);
    if (row.status === 'proposing') {
      log.error({ cycle, batchId: row.id }, 'affiliate batch stuck in proposing; manual Safe-queue verification required');
      await alerts.alert('affiliate-reconcile', `Affiliate cycle ${cycle} is stuck in 'proposing'; a Safe submit was attempted but no hash persisted. Verify the Safe queue before any retry.`).catch(() => {});
      continue;
    }
    const hash = row.safeProposalHash;
    if (!hash) {
      log.warn({ cycle, batchId: row.id }, "affiliate 'proposed' row without a hash; skipping");
      continue;
    }
    let status;
    try {
      status = await getProposalStatus(opts.chainId, hash);
    } catch (err) {
      log.warn({ err, cycle, batchId: row.id }, 'affiliate reconcile poll failed; retry next run');
      continue;
    }
    if (status.executed) {
      const newStatus = status.isSuccessful ? 'executed' : 'failed';
      await db.update(schema.affiliateBatches).set({ status: newStatus, safeTxHash: status.transactionHash ?? undefined, updatedAt: now }).where(eq(schema.affiliateBatches.id, row.id));
      if (status.isSuccessful) {
        advancedExecuted++;
        await markAffiliateEntriesPaid(row.id);
        await alerts.alert('affiliate-reconcile', `Affiliate cycle ${cycle} EXECUTED on-chain (tx ${status.transactionHash}).`).catch(() => {});
      } else {
        advancedFailed++;
        log.error({ cycle, batchId: row.id, txHash: status.transactionHash }, 'affiliate batch EXECUTION FAILED on-chain; referrers NOT paid');
        await alerts.alert('affiliate-reconcile', `Affiliate cycle ${cycle} Safe execution FAILED on-chain (tx ${status.transactionHash}); referrers were NOT paid. Investigate before re-proposing.`).catch(() => {});
      }
      continue;
    }
    const since = row.createdAt;
    const ageDays = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
    if (ageDays >= UNSIGNED_NAG_DAYS) {
      log.warn({ cycle, batchId: row.id, ageDays }, 'affiliate batch unsigned past threshold; nagging');
      await alerts.alert('affiliate-reconcile', `Affiliate cycle ${cycle} has been awaiting signature for ${ageDays} days. Sign it in the Safe queue.`).catch(() => {});
    }
  }
  return { checked: open.length, advancedExecuted, advancedFailed };
}
