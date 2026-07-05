import { and, eq, inArray } from 'drizzle-orm';
import { createPublicClient, http, parseAbi } from 'viem';
import { db, schema, sql } from '../db/index.js';
import { SOVEREIGN_CHAIN_IDS } from '../affiliate/rates.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';
import { priceTrade } from '../pricer.js';
import { proposeRebateBatch, getNextSafeNonce } from '../batch/propose.js';
import { getProposalStatus, waitForExecution } from '../batch/poll.js';
import { computeOwnFeeAccrual, type OwnFeeOwed } from './accrual.js';
import { assertOwnFeeRecipientsSane, SOVEREIGN_OWN_FEE_RECIPIENTS } from './recipients.js';
import { planOwnFeePayout } from './payoutPlan.js';
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

/**
 * How many recent settled months accrual catches up each run. Bounds the catch-up so a
 * long-missed run re-accrues a fixed recent window (the current settled month plus the
 * prior five) rather than every month since genesis. A month older than this window that
 * was never accrued stays unaccrued (surfaced by ops, not silently re-created forever).
 */
const OWN_FEE_ACCRUAL_LOOKBACK_MONTHS = 6;

/** The settled (previous) calendar month for a cron firing on the 1st of `now`. */
function settledWindow(now: Date): { start: Date; end: Date; label: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end, label: `${start.toISOString().slice(0, 10)}` }; // YYYY-MM-01
}

/**
 * The recent settled (fully elapsed) months to (re)accrue this run, OLDEST first. The
 * LAST element is settledWindow(now) (the current settled month); earlier elements are
 * the preceding months within OWN_FEE_ACCRUAL_LOOKBACK_MONTHS, so a missed run is caught
 * up in order. Each entry is the [start, end) UTC month bounds plus the YYYY-MM-01 label.
 */
function settledMonthsToAccrue(now: Date): { start: Date; end: Date; label: string }[] {
  const months: { start: Date; end: Date; label: string }[] = [];
  for (let i = OWN_FEE_ACCRUAL_LOOKBACK_MONTHS; i >= 1; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    months.push({ start, end, label: start.toISOString().slice(0, 10) });
  }
  return months;
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
  /**
   * Read the next free Safe nonce on `chainId` at most ONCE per run (default: getNextSafeNonce
   * for the Ophis Safe). The CALLER owns the nonce: it reads this lazily, only when the first
   * batch actually reaches proposal, then derives each subsequent catch-up proposal's nonce
   * locally (+1), so no proposal outcome (including a post-send 'attempted' failure) can desync
   * it into a re-read + collision. A run where every payable batch is BLOCKED never calls it. (Codex #474)
   */
  readonly getNextNonce?: (args: { chainId: number; rpcUrl: string }) => Promise<number>;
  /** Safe MultiSend proposer (default: proposeRebateBatch). */
  readonly propose?: typeof proposeRebateBatch;
  /** Background finality poller (default: waitForExecution). */
  readonly waitForExecution?: typeof waitForExecution;
}

async function defaultReadSafeWethBalanceWei(args: { chainId: number; rpcUrl: string; weth: `0x${string}` }): Promise<bigint> {
  const client = createPublicClient({ transport: http(args.rpcUrl) });
  return client.readContract({ address: args.weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
}

async function defaultGetNextNonce(args: { chainId: number; rpcUrl: string }): Promise<number> {
  return getNextSafeNonce(args.chainId, OPHIS_SAFE_ADDRESS);
}

async function defaultFetchWethUsdPrice(args: { chainId: number; weth: `0x${string}` }): Promise<number> {
  return priceTrade({ tradeUid: `0x${'00'.repeat(56)}` as `0x${string}`, chainId: args.chainId, sellToken: args.weth, sellAmount: 10n ** 18n });
}

/**
 * PHASE A -- ACCRUAL. Always runs (flag-INDEPENDENT). Computes the owed per allowlisted
 * recipient on one sovereign chain and records a batch at status 'computed' (recorded,
 * NOT proposed) + its entries. Reads NO Safe balance and proposes NOTHING.
 *
 * CATCH-UP: it does NOT only accrue the single current settled month. It walks the recent
 * settled months (OWN_FEE_ACCRUAL_LOOKBACK_MONTHS, oldest first) and (re)accrues each one
 * that is NOT already locked, so a month that a transient price/DB failure or a late-priced
 * trade left without a LOCKED batch is still caught up on a later run (the cron otherwise
 * advances past it and never revisits it). Returns the CURRENT settled month's result.
 *
 * Idempotency, applied PER month by the status of its (cycle_month, chain_id) batch:
 *   - LOCKED (proposing/proposed/executed/failed) => it has been proposed; leave it
 *     UNTOUCHED (never re-accrue or double-pay). Returns 'locked' for that month.
 *   - 'computed' or 'no_recipients' => re-accrue: recompute and REPLACE the owed + entries
 *     (picks up late-indexed trades before proposal), flipping status between 'computed'
 *     and 'no_recipients' as the owed set requires.
 *   - none => insert atomically ('computed' when there are recipients, 'no_recipients' when
 *     empty). A BACK-month with nothing owed records NOTHING (see accrueOwnFeeMonth).
 */
export async function accrueOwnFee(deps: OwnFeeAccrualDeps): Promise<{ status: string; batchId?: number }> {
  const now = deps.now ?? new Date();
  const allowlist = deps.allowlist ?? SOVEREIGN_OWN_FEE_RECIPIENTS;

  // Fail closed on a misconfigured allowlist (Ophis Safe / zero can never be paid).
  assertOwnFeeRecipientsSane(allowlist);

  // Sovereign-only: own fee is swept to the Ophis Safe and paid back on the SAME chain.
  if (!SOVEREIGN_CHAIN_IDS.has(deps.chainId)) {
    throw new Error(`accrueOwnFee: chain ${deps.chainId} is not sovereign; own-fee accrual is Optimism/Unichain only`);
  }
  const weth = WETH_BY_CHAIN[deps.chainId];
  if (!weth) throw new Error(`no WETH address for chain ${deps.chainId}`);

  // The FRESH WETH/USD spot used to size owed WETH at a month's FIRST accrual. Fetched at
  // most ONCE per run and shared across every month that needs a fresh price (memoized), so
  // a run that only re-accrues existing rows (or is fully locked) never fetches. Each month
  // LOCKS its price at first accrual: a re-accrual of an existing unlocked back-month reuses
  // that row's STORED weth_usd_price instead of this spot (see accrueOwnFeeMonth), so the
  // owed WETH is deterministic and only moves when new trades change the USD volume.
  const fetchPrice = deps.fetchWethUsdPrice ?? defaultFetchWethUsdPrice;
  let pricePromise: Promise<number> | undefined;
  const getWethUsdPrice = () => (pricePromise ??= fetchPrice({ chainId: deps.chainId, weth }));

  // Walk the recent settled months oldest first; the last one is the current settled month
  // whose result we return (back-compat with the single-month callers + tests).
  const months = settledMonthsToAccrue(now);
  let current: { status: string; batchId?: number } = { status: 'no_recipients' };
  for (let i = 0; i < months.length; i++) {
    const isCurrentSettled = i === months.length - 1;
    const r = await accrueOwnFeeMonth(deps, months[i]!, allowlist, getWethUsdPrice, isCurrentSettled, now);
    if (isCurrentSettled) current = r;
  }
  return current;
}

/**
 * Accrue (or re-accrue) ONE settled month for one sovereign chain. Extracted so the
 * catch-up loop applies the same idempotency rules to every month:
 *   - LOCKED => leave untouched (never re-accrue); returns 'locked'.
 *   - existing unlocked ('computed'/'no_recipients') => re-accrue: recompute and REPLACE
 *     owed + entries ATOMICALLY (picks up a late-indexed trade before proposal).
 *   - no row yet => insert the batch AND its entries in ONE transaction.
 *
 * `isCurrentSettled` distinguishes the current settled month (always recorded, even when
 * empty, so a no-activity month still gets its 'no_recipients' ledger row, preserving the
 * single-month behavior) from a BACK-month with nothing owed (recorded as NOTHING: a dead
 * back-month has nothing to lose, and creating empty rows would litter the ledger and race
 * a later real accrual for that month).
 */
async function accrueOwnFeeMonth(
  deps: OwnFeeAccrualDeps,
  month: { start: Date; end: Date; label: string },
  allowlist: ReadonlySet<string>,
  getWethUsdPrice: () => Promise<number>,
  isCurrentSettled: boolean,
  now: Date,
): Promise<{ status: string; batchId?: number }> {
  const label = month.label;
  const [existing] = await db
    .select()
    .from(schema.ownFeeBatches)
    .where(and(eq(schema.ownFeeBatches.cycleMonth, label), eq(schema.ownFeeBatches.chainId, deps.chainId)));

  // LOCKED: already proposed => never re-accrue (no double-pay).
  if (existing && (PROPOSED_STATUSES as readonly string[]).includes(existing.status)) {
    log.info({ cycleMonth: label, chainId: deps.chainId, status: existing.status }, 'own-fee batch already proposed; leaving locked (no re-accrual)');
    return { status: 'locked', batchId: existing.id };
  }

  // LOCK the month's WETH price at its FIRST accrual. An existing UNLOCKED row
  // ('computed'/'no_recipients') is re-accrued at its OWN stored weth_usd_price, so a
  // settled back-month with no new trades pays the SAME owed WETH on every later run
  // (deterministic) and, even with new trades, the added volume is priced at the month's
  // original spot -- never a later spot that only moved because ETH did. Only a month with
  // NO row yet (a newly-accrued or missed month's first accrual, or the current settled
  // month's first accrual) fetches the FRESH spot (memoized, so several brand-new months in
  // one run share one network call). Existing rows never trigger or use the fetch. (Codex P2)
  const wethUsdPrice =
    existing && existing.wethUsdPrice != null
      ? parseFloat(existing.wethUsdPrice)
      : await getWethUsdPrice();
  const owed = await computeOwnFeeAccrual(deps.chainId, month.start, month.end, wethUsdPrice, allowlist);
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

  // No row yet. A BACK-month with nothing owed records NOTHING (nothing to lose; avoids
  // littering the ledger with empty rows and racing a later real accrual for that month).
  if (!isCurrentSettled && owed.length === 0) {
    return { status: 'no_recipients' };
  }

  // FIRST accrual for this month: insert the batch row AND its entries in ONE transaction,
  // so a crash/failure between them can never leave a 'computed' batch with NO entries
  // (which propose would treat as empty/zero and never re-accrue, since a row now exists).
  // Mirrors the re-accrual path's atomicity above.
  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(schema.ownFeeBatches)
      .values({ cycleMonth: label, chainId: deps.chainId, totalOwedWei, wethUsdPrice: String(wethUsdPrice), status })
      .returning();
    if (!batch) throw new Error('failed to insert own-fee batch');
    if (owed.length > 0) {
      await tx.insert(schema.ownFeeBatchEntries).values(
        owed.map((o) => ({ batchId: batch.id, recipient: o.recipient, owedWei: o.owedWei, status: 'pending' })),
      );
    }
    return batch.id;
  });
  log.info({ cycleMonth: label, chainId: deps.chainId, status, recipients: owed.length }, 'accrued own-fee batch');
  return { status, batchId };
}

/**
 * PHASE B -- PROPOSAL. Gated by OWN_FEE_PAYOUT_ENABLED (the cron caller checks it).
 * Proposes EVERY un-proposed 'computed' batch for the chain with owed > 0, OLDEST cycle
 * first -- current cycle AND any older ones, so a flag that was OFF for months pays the
 * accumulated back-owed once it flips ON (the resume/catch-up).
 *
 * OVER-DRAW GUARD (replaces the old non-persisting 'blocked' path): read the chain Safe
 * WETH balance ONCE, SUBTRACT the WETH already committed to OPEN own-fee proposals on this
 * chain (a prior 'proposing'/'proposed' batch still holds its owed WETH in the Safe, so the
 * raw balance double-counts it), then walk the batches keeping a running `remaining`. A
 * batch whose owed exceeds `remaining` is LEFT 'computed' (LOUD alert, no proposal) so it
 * retries next run once the Safe is funded -- and, because `remaining` starts net of the
 * already-queued proposals and is only further consumed by batches PROPOSED in the same run,
 * the queued (unsigned) proposals across BOTH runs can never together exceed the balance.
 * Each 'computed' batch is proposed AT MOST ONCE: once it flips to 'proposing'/'proposed'
 * it is never re-picked (no double-pay).
 *
 * NONCE PINNING: a single run can propose MULTIPLE back-month batches. The CALLER owns the
 * nonce -- it reads getNextSafeNonce at most ONCE, LAZILY, the first time a batch actually
 * reaches proposal, then passes an explicit nonce to every proposal and increments it locally
 * after each SUBMITTED one (a 'proposed' OR a post-send 'attempted', which may have consumed
 * the nonce). It never re-reads getNextNonce between proposals (which could race the Tx Service
 * and hand out the SAME nonce twice), and no proposal outcome can desync the counter. A run
 * whose every payable batch is over-draw-BLOCKED never reads the nonce at all, so an
 * underfunded run leaves its batches 'computed' + emits its BLOCKED alerts without throwing on
 * an unrelated Tx Service lookup. Same #360 spirit the fee conversion uses. (Codex #474)
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

  // RESERVE the WETH already committed to OPEN own-fee proposals on THIS chain. A prior
  // batch left 'proposing'/'proposed' (queued in the Safe, not yet signed/executed) still
  // holds its owed WETH in the Safe, so the raw on-chain balance double-counts it. Netting
  // it out here stops THIS run proposing more against funds already earmarked for that
  // queued tx (if both were later signed, the total would exceed the balance and executions
  // would revert). remaining = balance - reservedForQueued (clamped at 0). (money-safety P2)
  const [reservedRow] = await sql<{ reserved: string }[]>`
    SELECT COALESCE(SUM(total_owed_wei), 0)::text AS reserved
    FROM own_fee_batches
    WHERE chain_id = ${deps.chainId} AND status IN ('proposing', 'proposed')
  `;
  const reservedForQueued = BigInt(reservedRow?.reserved ?? '0');
  let remaining = balance > reservedForQueued ? balance - reservedForQueued : 0n;
  if (reservedForQueued > 0n) {
    log.info(
      { chainId: deps.chainId, balanceWei: balance.toString(), reservedForQueuedWei: reservedForQueued.toString(), remainingWei: remaining.toString() },
      'own-fee propose: reserved WETH already committed to queued (unsigned) own-fee proposals',
    );
  }
  let proposed = 0;
  let blocked = 0;
  // CALLER OWNS THE NONCE, read LAZILY: the next free Safe nonce is read at most ONCE per
  // run and ONLY the first time a batch actually reaches proposal (past the not-blocked +
  // has-transfers checks). A run where every payable batch is over-draw-BLOCKED (or has no
  // valid transfers) therefore never contacts the Safe Tx Service, so an underfunded run
  // cannot throw on an unused nonce lookup before it emits its BLOCKED alerts + count. Once
  // read, we pass an explicit nonce to every proposal and advance it locally (+1); we never
  // re-read getNextNonce between proposals (where the Tx Service may not yet reflect a
  // just-posted tx and could hand out a colliding nonce), so no proposal outcome can desync
  // it. (Codex #474 caller-owned nonce; Codex P2 lazy read)
  const readNonce = deps.getNextNonce ?? defaultGetNextNonce;
  let nextNonce: number | undefined;

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
        .alert('own-fee-payout', `Own-fee batch ${cycle} chain ${deps.chainId} BLOCKED: owed ${plan.totalOwedWei} > available Safe WETH ${remaining} wei (net of queued proposals). Left as 'computed'; fund the Safe and it proposes next run.`)
        .catch(() => {});
      continue;
    }

    // First batch that will REALLY be proposed: read the caller-owned nonce now (lazily,
    // at most once). A fully-blocked run never reaches here, so getNextNonce is never
    // called. After this every proposal takes the caller-owned nonce, so a post-send
    // failure can never leave the next batch to re-read a stale nonce and collide.
    if (nextNonce === undefined) {
      nextNonce = await readNonce({ chainId: deps.chainId, rpcUrl: deps.rpcUrl });
    }
    const outcome = await proposeComputedBatch(batch, plan.transfers, deps, nextNonce);
    if (outcome === 'proposed') {
      proposed++;
      remaining -= plan.totalOwedWei;
      nextNonce++;
    } else if (outcome === 'attempted') {
      // Submit failed AFTER send: a proposal MAY be queued at nextNonce, so conservatively
      // consume BOTH the balance (avoids a later batch this run over-drawing) and the nonce
      // (a later batch must not reuse it). Left 'proposing' for the reconciler; not a clean
      // propose.
      remaining -= plan.totalOwedWei;
      nextNonce++;
    }
    // 'presubmit-failed' => nothing queued, batch stays 'computed', balance + nonce untouched.
  }
  return { checked: payable.length, proposed, blocked };
}

/**
 * Propose one 'computed' batch (already balance-cleared by the caller). Mirrors the
 * affiliate submit flow: 'computed' -> 'proposing' at onBeforeSubmit -> 'proposed' +
 * safe_proposal_hash -> fire-and-forget poll -> executed/failed. Entries stay 'pending'
 * until reconcile confirms execution. Never throws -- returns an outcome so one bad batch
 * cannot abort the rest of the run.
 *
 * `nonce` is the caller-owned Safe nonce for THIS proposal (always defined): the caller
 * reads getNextSafeNonce once per run and advances it locally after each submitted proposal,
 * so a same-run catch-up never collides even when the Tx Service lags. (#360, Codex #474)
 */
async function proposeComputedBatch(
  batch: { id: number; cycleMonth: string; totalOwedWei: bigint },
  transfers: readonly { to: `0x${string}`; amount: bigint }[],
  deps: OwnFeeProposeDeps,
  nonce: number,
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
      nonce,
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
  log.info({ batchId: batch.id, chainId: deps.chainId, safeTxHash, nonce, recipients: transfers.length }, 'own-fee batch proposed');
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
