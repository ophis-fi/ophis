import { and, eq, inArray } from 'drizzle-orm';
import { createPublicClient, http, parseAbi } from 'viem';
import { db, schema, sql } from '../db/index.js';
import { SOVEREIGN_CHAIN_IDS } from '../affiliate/rates.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';
import { priceTrade } from '../pricer.js';
import { proposeRebateBatch } from '../batch/propose.js';
import { getProposalStatus, waitForExecution } from '../batch/poll.js';
import { computeOwnFeeAccrual, type OwnFeeOwed } from './accrual.js';
import { assertOwnFeeRecipientsSane, SOVEREIGN_OWN_FEE_RECIPIENTS } from './recipients.js';
import { planOwnFeePayout, resolveOwnFeePayoutEnabled } from './payoutPlan.js';
import { notify, alerts } from '../telegram/alerter.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'own-fee-payout' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

// The own-fee payout is DELIBERATELY two-phase so the ledger is never lost to a flag:
//   ACCRUAL (accrueOwnFee)  -- ALWAYS runs, flag-INDEPENDENT. Records what each
//     allowlisted recipient is owed for the settled month into a batch at status
//     'computed' (recorded, NOT proposed) + its entries. Re-accruable while still
//     'computed'/'no_recipients' (picks up late-indexed trades); LOCKED once proposed.
//   PROPOSAL (proposeOwnFeeBatches)  -- gated by OWN_FEE_PAYOUT_ENABLED. Proposes ALL
//     un-proposed 'computed' batches for the chain (current cycle AND any older ones),
//     so a flag that was OFF for months still pays back-owed when it flips ON. The Safe
//     over-draw guard lives here; execution still needs the 2-of-3 human signature.
// This split means no back-owed is ever lost: accrual keeps recording regardless, and a
// later enabled run proposes every un-proposed 'computed' batch (including back-months).

export { resolveOwnFeePayoutEnabled, planOwnFeePayout } from './payoutPlan.js';

/** Statuses at/after PROPOSAL: a batch here is LOCKED to accrual (never re-accrue). */
const PROPOSED_STATUSES = ['proposing', 'proposed', 'executed', 'failed'] as const;

/** The settled (previous) calendar month for a cron firing on the 1st of `now`. */
function settledWindow(now: Date): { start: Date; end: Date; label: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end, label: `${start.toISOString().slice(0, 10)}` }; // YYYY-MM-01
}

// Injectable I/O so tests can exercise the ledger + proposal flow without a live chain or
// Safe service (mirrors the affiliate/backfill injection style). Prod uses the defaults.
export interface OwnFeeAccrualDeps {
  readonly chainId: number; // sovereign: 10 (Optimism) or 130 (Unichain)
  readonly now?: Date;
  /** Allowlist override (defaults to the real fail-closed set). */
  readonly allowlist?: ReadonlySet<string>;
  /** USD per 1 WETH on `chainId` (default: priceTrade of 1 WETH). */
  readonly fetchWethUsdPrice?: (args: { chainId: number; weth: `0x${string}` }) => Promise<number>;
}

export interface OwnFeeProposeDeps {
  readonly chainId: number; // sovereign: 10 (Optimism) or 130 (Unichain)
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  /** Global dry-run switch (BATCHER_PROPOSE_ENABLED). false => record only, never submit. */
  readonly proposeEnabled: boolean;
  /** Read the Ophis Safe's WETH balance on `chainId` (default: on-chain balanceOf). */
  readonly readSafeWethBalanceWei?: (args: { chainId: number; rpcUrl: string; weth: `0x${string}` }) => Promise<bigint>;
  /** Safe MultiSend proposer (default: proposeRebateBatch). */
  readonly propose?: typeof proposeRebateBatch;
  /** Background finality poller (default: waitForExecution). */
  readonly waitForExecution?: typeof waitForExecution;
}

async function defaultReadSafeWethBalanceWei(args: { chainId: number; rpcUrl: string; weth: `0x${string}` }): Promise<bigint> {
  const client = createPublicClient({ transport: http(args.rpcUrl) });
  return client.readContract({ address: args.weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
}

async function defaultFetchWethUsdPrice(args: { chainId: number; weth: `0x${string}` }): Promise<number> {
  return priceTrade({ tradeUid: `0x${'00'.repeat(56)}` as `0x${string}`, chainId: args.chainId, sellToken: args.weth, sellAmount: 10n ** 18n });
}

/**
 * PHASE A -- ACCRUAL. Always runs (flag-INDEPENDENT). Computes the settled-month owed per
 * allowlisted recipient on one sovereign chain and records a batch at status 'computed'
 * (recorded, NOT proposed) + its entries. Reads NO Safe balance and proposes NOTHING.
 *
 * Idempotency by status of any existing (cycle_month, chain_id) batch:
 *   - LOCKED (proposing/proposed/executed/failed) => it has been proposed; leave it
 *     UNTOUCHED (never re-accrue or double-pay). Returns 'locked'.
 *   - 'computed' or 'no_recipients' => re-accrue: recompute and REPLACE the owed + entries
 *     (picks up late-indexed trades before proposal), flipping status between 'computed'
 *     and 'no_recipients' as the owed set requires.
 *   - none => insert ('computed' when there are recipients, 'no_recipients' when empty).
 */
export async function accrueOwnFee(deps: OwnFeeAccrualDeps): Promise<{ status: string; batchId?: number }> {
  const now = deps.now ?? new Date();
  const { start, end, label } = settledWindow(now);
  const allowlist = deps.allowlist ?? SOVEREIGN_OWN_FEE_RECIPIENTS;

  // Fail closed on a misconfigured allowlist (Ophis Safe / zero can never be paid).
  assertOwnFeeRecipientsSane(allowlist);

  // Sovereign-only: own fee is swept to the Ophis Safe and paid back on the SAME chain.
  if (!SOVEREIGN_CHAIN_IDS.has(deps.chainId)) {
    throw new Error(`accrueOwnFee: chain ${deps.chainId} is not sovereign; own-fee accrual is Optimism/Unichain only`);
  }
  const weth = WETH_BY_CHAIN[deps.chainId];
  if (!weth) throw new Error(`no WETH address for chain ${deps.chainId}`);

  const [existing] = await db
    .select()
    .from(schema.ownFeeBatches)
    .where(and(eq(schema.ownFeeBatches.cycleMonth, label), eq(schema.ownFeeBatches.chainId, deps.chainId)));

  // LOCKED: already proposed => never re-accrue (no double-pay).
  if (existing && (PROPOSED_STATUSES as readonly string[]).includes(existing.status)) {
    log.info({ cycleMonth: label, chainId: deps.chainId, status: existing.status }, 'own-fee batch already proposed; leaving locked (no re-accrual)');
    return { status: 'locked', batchId: existing.id };
  }

  const fetchPrice = deps.fetchWethUsdPrice ?? defaultFetchWethUsdPrice;
  const wethUsdPrice = await fetchPrice({ chainId: deps.chainId, weth });

  const owed = await computeOwnFeeAccrual(deps.chainId, start, end, wethUsdPrice, allowlist);
  const totalOwedWei = owed.reduce((acc, o) => acc + o.owedWei, 0n);
  const status = owed.length > 0 ? 'computed' : 'no_recipients';

  if (existing) {
    // Re-accrue a still-un-proposed batch: REPLACE owed + entries atomically (handles a
    // late-indexed trade arriving before the proposal; safe because it is not yet locked).
    await db.transaction(async (tx) => {
      await tx
        .update(schema.ownFeeBatches)
        .set({ totalOwedWei, wethUsdPrice: String(wethUsdPrice), status, updatedAt: now })
        .where(eq(schema.ownFeeBatches.id, existing.id));
      await tx.delete(schema.ownFeeBatchEntries).where(eq(schema.ownFeeBatchEntries.batchId, existing.id));
      if (owed.length > 0) {
        await tx.insert(schema.ownFeeBatchEntries).values(
          owed.map((o) => ({ batchId: existing.id, recipient: o.recipient, owedWei: o.owedWei, status: 'pending' })),
        );
      }
    });
    log.info({ cycleMonth: label, chainId: deps.chainId, status, recipients: owed.length }, 're-accrued own-fee batch (pre-proposal update)');
    return { status, batchId: existing.id };
  }

  const [batch] = await db
    .insert(schema.ownFeeBatches)
    .values({ cycleMonth: label, chainId: deps.chainId, totalOwedWei, wethUsdPrice: String(wethUsdPrice), status })
    .returning();
  if (!batch) throw new Error('failed to insert own-fee batch');
  if (owed.length > 0) {
    await db.insert(schema.ownFeeBatchEntries).values(
      owed.map((o) => ({ batchId: batch.id, recipient: o.recipient, owedWei: o.owedWei, status: 'pending' })),
    );
  }
  log.info({ cycleMonth: label, chainId: deps.chainId, status, recipients: owed.length }, 'accrued own-fee batch');
  return { status, batchId: batch.id };
}

/**
 * PHASE B -- PROPOSAL. Gated by OWN_FEE_PAYOUT_ENABLED (the cron caller checks it).
 * Proposes EVERY un-proposed 'computed' batch for the chain with owed > 0, OLDEST cycle
 * first -- current cycle AND any older ones, so a flag that was OFF for months pays the
 * accumulated back-owed once it flips ON (the resume/catch-up).
 *
 * OVER-DRAW GUARD (replaces the old non-persisting 'blocked' path): read the chain Safe
 * WETH balance ONCE, then walk the batches keeping a running `remaining`. A batch whose
 * owed exceeds `remaining` is LEFT 'computed' (LOUD alert, no proposal) so it retries next
 * run once the Safe is funded -- and, because balance is only consumed by PROPOSED batches
 * in the same run, the queued (unsigned) proposals can never together exceed the balance.
 * Each 'computed' batch is proposed AT MOST ONCE: once it flips to 'proposing'/'proposed'
 * it is never re-picked (no double-pay).
 */
export async function proposeOwnFeeBatches(deps: OwnFeeProposeDeps): Promise<{ checked: number; proposed: number; blocked: number; dryRun?: boolean }> {
  if (!SOVEREIGN_CHAIN_IDS.has(deps.chainId)) {
    throw new Error(`proposeOwnFeeBatches: chain ${deps.chainId} is not sovereign; own-fee payout is Optimism/Unichain only`);
  }
  const weth = WETH_BY_CHAIN[deps.chainId];
  if (!weth) throw new Error(`no WETH address for chain ${deps.chainId}`);

  const computed = await db
    .select()
    .from(schema.ownFeeBatches)
    .where(and(eq(schema.ownFeeBatches.chainId, deps.chainId), eq(schema.ownFeeBatches.status, 'computed')))
    .orderBy(schema.ownFeeBatches.cycleMonth);
  // Only batches that actually owe WETH (a 'computed' with 0 owed should not exist, but
  // guard defensively so an empty batch is never proposed).
  const payable = computed.filter((b) => b.totalOwedWei > 0n);
  if (payable.length === 0) return { checked: 0, proposed: 0, blocked: 0 };

  if (!deps.proposeEnabled) {
    log.info({ chainId: deps.chainId, computed: payable.length }, 'own-fee dry-run: computed batches recorded, not proposing');
    return { checked: payable.length, proposed: 0, blocked: 0, dryRun: true };
  }

  const readBalance = deps.readSafeWethBalanceWei ?? defaultReadSafeWethBalanceWei;
  const balance = await readBalance({ chainId: deps.chainId, rpcUrl: deps.rpcUrl, weth });
  let remaining = balance;
  let proposed = 0;
  let blocked = 0;

  for (const batch of payable) {
    const cycle = batch.cycleMonth.slice(0, 7);
    const entries = await db
      .select({ recipient: schema.ownFeeBatchEntries.recipient, owedWei: schema.ownFeeBatchEntries.owedWei })
      .from(schema.ownFeeBatchEntries)
      .where(eq(schema.ownFeeBatchEntries.batchId, batch.id));
    // owedUsd is unused by the pure planner; only recipient + owedWei drive the transfers.
    const owedList: OwnFeeOwed[] = entries.map((e) => ({ recipient: e.recipient, owedUsd: 0, owedWei: e.owedWei }));

    // Reuse the validated pure planner: it drops zero/Ophis/zero-amount recipients and
    // BLOCKS when this batch's owed exceeds the running available balance.
    const plan = planOwnFeePayout(owedList, remaining);
    if (plan.transfers.length === 0 && !plan.blocked) {
      log.warn({ cycle, batchId: batch.id, chainId: deps.chainId }, 'own-fee computed batch has no valid transfers; skipping');
      continue;
    }
    if (plan.blocked) {
      blocked++;
      log.error({ cycle, batchId: batch.id, chainId: deps.chainId, owed: plan.totalOwedWei.toString(), remaining: remaining.toString() }, 'own-fee batch BLOCKED (owed exceeds available Safe WETH)');
      await alerts
        .alert('own-fee-payout', `Own-fee batch ${cycle} chain ${deps.chainId} BLOCKED: owed ${plan.totalOwedWei} > available Safe WETH ${remaining} wei. Left as 'computed'; fund the Safe and it proposes next run.`)
        .catch(() => {});
      continue;
    }

    const outcome = await proposeComputedBatch(batch, plan.transfers, deps);
    if (outcome === 'proposed') {
      proposed++;
      remaining -= plan.totalOwedWei;
    } else if (outcome === 'attempted') {
      // Submit failed AFTER send: a proposal MAY be queued, so conservatively consume the
      // balance (avoids a later batch this run over-drawing). Left 'proposing' for the
      // reconciler; not counted as a clean propose.
      remaining -= plan.totalOwedWei;
    }
    // 'presubmit-failed' => nothing queued, batch stays 'computed', balance untouched.
  }
  return { checked: payable.length, proposed, blocked };
}

/**
 * Propose one 'computed' batch (already balance-cleared by the caller). Mirrors the
 * affiliate submit flow: 'computed' -> 'proposing' at onBeforeSubmit -> 'proposed' +
 * safe_proposal_hash -> fire-and-forget poll -> executed/failed. Entries stay 'pending'
 * until reconcile confirms execution. Never throws -- returns an outcome so one bad batch
 * cannot abort the rest of the run.
 */
async function proposeComputedBatch(
  batch: { id: number; cycleMonth: string; totalOwedWei: bigint },
  transfers: readonly { to: `0x${string}`; amount: bigint }[],
  deps: OwnFeeProposeDeps,
): Promise<'proposed' | 'attempted' | 'presubmit-failed'> {
  const cycle = batch.cycleMonth.slice(0, 7);
  const propose = deps.propose ?? proposeRebateBatch;
  let submitAttempted = false;
  let safeTxHash: `0x${string}`;
  try {
    ({ safeTxHash } = await propose({
      chainId: deps.chainId,
      rpcUrl: deps.rpcUrl,
      proposerPrivateKey: deps.proposerPrivateKey,
      transfers: transfers.map((t) => ({ to: t.to, amount: t.amount })),
      onBeforeSubmit: async () => {
        await db.update(schema.ownFeeBatches).set({ status: 'proposing', updatedAt: new Date() }).where(eq(schema.ownFeeBatches.id, batch.id));
        submitAttempted = true;
      },
    }));
  } catch (err) {
    if (submitAttempted) {
      log.error({ err, batchId: batch.id, cycle, chainId: deps.chainId }, 'own-fee submit failed after send; left proposing for manual verification');
      await alerts.alert('own-fee-payout', `Own-fee batch ${cycle} chain ${deps.chainId} Safe submit FAILED after send. A proposal may or may not exist -- verify the Safe queue before retrying.`).catch(() => {});
      return 'attempted';
    }
    log.error({ err, batchId: batch.id, cycle, chainId: deps.chainId }, 'own-fee pre-submit failed; left computed for auto-retry');
    await alerts.alert('own-fee-payout', `Own-fee batch ${cycle} chain ${deps.chainId} failed BEFORE the Safe submit (no proposal queued); left 'computed' to retry next run.`).catch(() => {});
    return 'presubmit-failed';
  }

  await db.update(schema.ownFeeBatches).set({ status: 'proposed', safeProposalHash: safeTxHash, updatedAt: new Date() }).where(eq(schema.ownFeeBatches.id, batch.id));

  const wait = deps.waitForExecution ?? waitForExecution;
  wait({ chainId: deps.chainId, safeTxHash })
    .then(async (r) => {
      if (r.executed) {
        await db.update(schema.ownFeeBatches).set({ status: r.isSuccessful ? 'executed' : 'failed', safeTxHash: r.transactionHash ?? undefined, updatedAt: new Date() }).where(eq(schema.ownFeeBatches.id, batch.id));
        if (r.isSuccessful) await markOwnFeeEntriesPaid(batch.id);
      }
    })
    .catch((err) => log.error({ err, batchId: batch.id }, 'own-fee polling failed'));

  await notify(`Own-fee payout ${cycle} (chain ${deps.chainId}) proposed: ${(Number(batch.totalOwedWei) / 1e18).toFixed(5)} WETH across ${transfers.length} recipient(s). Awaiting 2-of-3 signature.`);
  log.info({ batchId: batch.id, chainId: deps.chainId, safeTxHash, recipients: transfers.length }, 'own-fee batch proposed');
  return 'proposed';
}

/** Mark all entries of an executed own-fee batch as paid (atomic MultiSend = all paid). */
async function markOwnFeeEntriesPaid(batchId: number): Promise<void> {
  await sql`UPDATE own_fee_batch_entries SET paid_wei = owed_wei, status = 'paid' WHERE batch_id = ${batchId}`;
}

const UNSIGNED_NAG_DAYS = 3;

/**
 * Nightly reconciliation of non-terminal own-fee batches -- the mirror of
 * reconcileAffiliateBatches for the SEPARATE own-fee tables. Heals 'proposed' rows whose
 * in-process finality poller was lost on a restart, marks entries paid on success,
 * surfaces 'proposing' rows for manual verification, and nags unsigned proposals. Each
 * row carries its own chain_id, so it polls the Safe service on the RIGHT chain (10/130).
 * READ-ONLY against the Safe service: it never proposes or pays, so it cannot double-pay
 * and is safe to run unconditionally. It does NOT touch 'computed'/'no_recipients' rows.
 */
export async function reconcileOwnFeeBatches(opts: { now?: Date } = {}): Promise<{ checked: number; advancedExecuted: number; advancedFailed: number }> {
  const now = opts.now ?? new Date();
  let advancedExecuted = 0;
  let advancedFailed = 0;

  const open = await db.select().from(schema.ownFeeBatches).where(inArray(schema.ownFeeBatches.status, ['proposing', 'proposed']));
  for (const row of open) {
    const cycle = row.cycleMonth.slice(0, 7);
    if (row.status === 'proposing') {
      log.error({ cycle, batchId: row.id, chainId: row.chainId }, 'own-fee batch stuck in proposing; manual Safe-queue verification required');
      await alerts.alert('own-fee-reconcile', `Own-fee cycle ${cycle} chain ${row.chainId} is stuck in 'proposing'; a Safe submit was attempted but no hash persisted. Verify the Safe queue before any retry.`).catch(() => {});
      continue;
    }
    const hash = row.safeProposalHash;
    if (!hash) {
      log.warn({ cycle, batchId: row.id }, "own-fee 'proposed' row without a hash; skipping");
      continue;
    }
    let status;
    try {
      status = await getProposalStatus(row.chainId, hash);
    } catch (err) {
      log.warn({ err, cycle, batchId: row.id }, 'own-fee reconcile poll failed; retry next run');
      continue;
    }
    if (status.executed) {
      const newStatus = status.isSuccessful ? 'executed' : 'failed';
      await db.update(schema.ownFeeBatches).set({ status: newStatus, safeTxHash: status.transactionHash ?? undefined, updatedAt: now }).where(eq(schema.ownFeeBatches.id, row.id));
      if (status.isSuccessful) {
        advancedExecuted++;
        await markOwnFeeEntriesPaid(row.id);
        await alerts.alert('own-fee-reconcile', `Own-fee cycle ${cycle} chain ${row.chainId} EXECUTED on-chain (tx ${status.transactionHash}).`).catch(() => {});
      } else {
        advancedFailed++;
        log.error({ cycle, batchId: row.id, chainId: row.chainId, txHash: status.transactionHash }, 'own-fee batch EXECUTION FAILED on-chain; recipients NOT paid');
        await alerts.alert('own-fee-reconcile', `Own-fee cycle ${cycle} chain ${row.chainId} Safe execution FAILED on-chain (tx ${status.transactionHash}); recipients were NOT paid. Investigate before re-proposing.`).catch(() => {});
      }
      continue;
    }
    const ageDays = Math.floor((now.getTime() - row.createdAt.getTime()) / 86_400_000);
    if (ageDays >= UNSIGNED_NAG_DAYS) {
      log.warn({ cycle, batchId: row.id, ageDays }, 'own-fee batch unsigned past threshold; nagging');
      await alerts.alert('own-fee-reconcile', `Own-fee cycle ${cycle} chain ${row.chainId} has been awaiting signature for ${ageDays} days. Sign it in the Safe queue.`).catch(() => {});
    }
  }
  return { checked: open.length, advancedExecuted, advancedFailed };
}
