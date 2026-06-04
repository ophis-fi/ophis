import { eq } from 'drizzle-orm';
import { sql, db, schema } from './db/index.js';
import { computeShares, type EligibleWallet } from './batch/computeShares.js';
import { computeDirectRebates } from './batch/computeDirectRebates.js';
import { buildEthCallSimulator, isolateBadRecipients, type Transfer } from './batch/dryRun.js';
import { proposeRebateBatch } from './batch/propose.js';
import { waitForExecution } from './batch/poll.js';
import { assignTier, POOL_SPLIT_BPS } from './tiers.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN, getRevenueAddress } from './safe/addresses.js';
import { getNonWethTokenBalances } from './safe/balances.js';
import { alerts } from './telegram/alerter.js';
import { createPublicClient, http, parseAbi } from 'viem';
import { logger } from './logger.js';

const log = logger.child({ module: 'batcher' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

// Telegram alerts are sent with parse_mode 'HTML' (alerter.ts). An ERC20
// `symbol` is attacker-controllable — anyone can airdrop a token with markup in
// its symbol — so escape untrusted token metadata before interpolating it.
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAX_ALERT_TOKENS = 12;

// Advisory-lock key for runBatcher single-flight. MUST be distinct from
// fetcher.ts's FETCHER_LOCK_KEY (770042) / PIPELINE_LOCK_KEY (770043): the cron
// path nests runBatcher inside withPipelineLock, so reusing the pipeline key
// would self-deadlock (a second reserved connection can't re-acquire it). (Codex P1)
const BATCHER_LOCK_KEY = 770044;

export interface BatcherDeps {
  readonly chainId: number;                                            // payout chain (100 in Phase 1)
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly proposeEnabled: boolean;                                    // false for first-batch dry-run safety
  readonly directMode?: boolean;                                       // undefined => resolve from REBATE_DIRECT_MODE env
}

export interface BatcherResult {
  readonly batchId: number;
  readonly status: 'computing' | 'proposing' | 'proposed' | 'no_recipients' | 'failed' | 'executed';
  readonly safeTxHash: `0x${string}` | null;
  readonly recipientCount: number;
  readonly poolWei: bigint;
}

/** First-of-month detection in UTC. The cron entrypoint calls this. */
export function isFirstOfMonth(now: Date = new Date()): boolean {
  return now.getUTCDate() === 1;
}

function cycleMonthKey(now: Date): string {
  // YYYY-MM-01 of the cycle being paid out — i.e., the current month's 1st.
  // Example: running on 2026-06-01 02:00 UTC → '2026-06-01'.
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Rebate distribution model. Default (unset/false/0) = the POOL model
 * (computeShares: POOL_SPLIT_BPS% of the Safe's WETH, weighted by volume*tier%).
 * 'true'/'1' = the DIRECT model (computeDirectRebates: each wallet gets its tier%
 * of its own fee-share, Ophis keeps the rest via the revenue sweep). Default-OFF
 * so the live deploy is byte-identical until flipped; any other value throws
 * (fail loud rather than silently choosing a payout model).
 */
function resolveDirectMode(): boolean {
  const raw = process.env.REBATE_DIRECT_MODE?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`REBATE_DIRECT_MODE must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

/**
 * Single-flight wrapper around the real batcher. runBatcher has TWO entrypoints:
 * the nightly cron (already serialized by withPipelineLock) AND the CLI
 * (`simulate-batch` / `dry-run-monthly` in cli.ts call it directly, with NO
 * pipeline lock). Without a guard here, an overlapping manual run that hits the
 * duplicate-cycle branch would treat the live run's 'computing' row as stale and
 * delete its entries — or, for two proposers, queue a second Safe payout. A
 * dedicated Postgres advisory lock makes runBatcher mutually exclusive across
 * BOTH paths; once held, any 'computing' row seen below is provably a crashed
 * prior run, never a live one, so the resume logic is unambiguously safe. The
 * lock is released before the fire-and-forget execution polling detaches (which
 * only updates an already-'proposed' row, against which concurrent runs abort).
 * (Codex P1)
 */
export async function runBatcher(deps: BatcherDeps, now: Date = new Date()): Promise<BatcherResult> {
  // SESSION-level lock ⇒ acquire + release MUST run on the same backend
  // connection; reserve a dedicated one for the lock's lifetime (the work runs on
  // the pool). Mirrors withPipelineLock in fetcher.ts.
  const lockConn = await sql.reserve();
  let locked = false;
  try {
    const [lk] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${BATCHER_LOCK_KEY}) AS locked`;
    locked = lk?.locked === true;
    if (!locked) {
      log.error({ cycleMonth: cycleMonthKey(now) }, 'another batcher run holds the advisory lock; aborting to avoid a concurrent cycle');
      throw new Error('batcher: another run holds the advisory lock; aborting to avoid a concurrent cycle (would risk deleting a live batch\'s entries or a duplicate Safe proposal)');
    }
    return await runBatcherLocked(deps, now);
  } finally {
    if (locked) {
      try {
        await lockConn`SELECT pg_advisory_unlock(${BATCHER_LOCK_KEY})`;
      } catch (err) {
        log.error({ err }, 'batcher advisory unlock failed');
      }
    }
    lockConn.release();
  }
}

async function runBatcherLocked(deps: BatcherDeps, now: Date): Promise<BatcherResult> {
  const cycleMonth = cycleMonthKey(now);
  const directMode = deps.directMode ?? resolveDirectMode();
  log.info({ cycleMonth, chainId: deps.chainId, proposeEnabled: deps.proposeEnabled, directMode }, 'batcher start');

  // 1. Read Safe WETH balance.
  const weth = WETH_BY_CHAIN[deps.chainId]!;
  const client = createPublicClient({ transport: http(deps.rpcUrl) });
  const netFee = await client.readContract({ address: weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
  const pool = (netFee * BigInt(POOL_SPLIT_BPS)) / 10_000n;

  // 1b. Issue #360 safety net — runs EVERY batcher cycle, regardless of the WETH
  //     pool. The rebate pool is WETH-only, so any value the Safe holds in OTHER
  //     tokens (CoW partner fees accrue in the trade's surplus token) is NOT
  //     distributed and accrues silently — including on a normal cycle where
  //     WETH pays out (a mixed WETH + token disbursement). Surface it loudly.
  //     The balances probe is timeout-bounded and never throws; the alert is
  //     fire-and-forget (+ its own timeout), so this can neither block nor break
  //     the payout that follows.
  try {
    const stranded = await getNonWethTokenBalances({ chainId: deps.chainId, safe: OPHIS_SAFE_ADDRESS, weth });
    if (stranded.length > 0) {
      // Cap the listed tokens so a dust/spam-flooded Safe can't produce a
      // message Telegram rejects; HTML-escape the (attacker-controllable) token
      // metadata since notify() sends with parse_mode 'HTML'.
      const shown = stranded
        .slice(0, MAX_ALERT_TOKENS)
        .map((t) => `${escapeHtml(t.symbol)} ${t.balance} (${escapeHtml(t.tokenAddress)})`)
        .join(', ');
      const detail = stranded.length > MAX_ALERT_TOKENS ? `${shown}, +${stranded.length - MAX_ALERT_TOKENS} more` : shown;
      log.warn({ strandedCount: stranded.length, stranded, poolWei: pool.toString() }, 'non-WETH value in Safe, not covered by WETH-only pool');
      // Fire-and-forget: a (bounded) Telegram send must not delay the payout.
      void alerts
        .alert(
          'batcher',
          `Safe holds non-WETH value NOT included in the WETH-only rebate pool: ${detail}. ` +
            `Partner fees may accrue in trade tokens (Issue #360); ` +
            (pool === 0n
              ? `the pool is 0 WETH so rebates will NOT pay this cycle until handled.`
              : `the WETH payout proceeds but this value is excluded and will accrue until converted/handled.`),
        )
        .catch((err) => log.warn({ err }, 'stranded-fee alert send failed'));
    }
  } catch (err) {
    log.warn({ err }, 'stranded-fee probe failed (ignored)');
  }

  // 2. Read eligible wallets.
  const eligible = await sql<{ wallet: Buffer; volume_30d_usd: string }[]>`
    SELECT wallet, volume_30d_usd::text FROM wallets WHERE volume_30d_usd > 0
  `;
  const wallets: EligibleWallet[] = eligible.map((r) => ({
    wallet: (`0x${r.wallet.toString('hex')}`) as `0x${string}`,
    volume_30d_usd: parseFloat(r.volume_30d_usd),
  }));

  // 3. Insert the batch row up-front so we have a stable ID even if subsequent
  //    steps fail. cycle_month is UNIQUE, so a row for this cycle may already
  //    exist from a prior run. We must distinguish two cases (audit P2-3):
  //      - already PROPOSED/terminal  → abort, never re-propose (no double-pay);
  //      - inserted 'computing'/'failed' but NEVER proposed (a prior run crashed
  //        at/before propose) → RESUME on the same row, so a transient failure
  //        cannot permanently wedge the month.
  let batchId: number;
  try {
    const inserted = await db
      .insert(schema.rebateBatches)
      .values({ cycleMonth: cycleMonth, netFeeWethWei: netFee, poolWethWei: pool, status: 'computing' })
      .returning({ id: schema.rebateBatches.id });
    batchId = inserted[0]!.id;
  } catch (err: any) {
    // 23505 = unique_violation. Branch on the SQLSTATE code, not the constraint
    // NAME: the inline `cycle_month ... UNIQUE` is auto-named
    // `rebate_batches_cycle_month_key` (NOT the `_unique` Drizzle convention the
    // old string match looked for, so that branch never fired).
    if (err?.code !== '23505') throw err;
    const existing = await db
      .select()
      .from(schema.rebateBatches)
      .where(eq(schema.rebateBatches.cycleMonth, cycleMonth))
      .limit(1);
    const row = existing[0];
    if (!row) throw err; // unexpected (cron is single-flight); surface it.

    // MID-PROPOSE crash: a prior run set 'proposing' immediately before the Safe
    // proposal call but never persisted a hash. Safe proposal-create and our DB
    // hash-write are NOT atomic, so a proposal MAY already be queued. Do NOT
    // auto-re-propose (a second queued Safe tx for the same cycle is a money-path
    // hazard); abort and alert for manual Safe-queue verification (audit P2-3).
    if (row.status === 'proposing') {
      log.error({ cycleMonth, batchId: row.id }, 'cycle stuck in proposing — manual Safe-queue verification required');
      void alerts
        .alert(
          'batcher',
          `Rebate cycle ${cycleMonth} is stuck in 'proposing': a prior run attempted the Safe proposal but did not persist its hash, so a proposal MAY already be queued. Verify the Safe queue manually; only after confirming NO proposal exists, reset this cycle's row to retry. Do NOT blindly re-trigger.`,
        )
        .catch((e) => log.warn({ err: e }, 'proposing-stuck alert failed'));
      return { batchId: row.id, status: 'proposing', safeTxHash: null, recipientCount: 0, poolWei: pool };
    }

    // EXECUTION FAILED: a prior cycle was proposed (hash persisted), signed, and
    // executed on-chain, but the Safe tx reported failure — poll.ts wrote 'failed'
    // WITHOUT clearing safe_proposal_hash. Recipients were NOT paid, yet a proposal
    // existed and may have moved partial value, so auto-re-proposing risks a
    // duplicate payout. Must come BEFORE the generic has-hash block below, which
    // would otherwise coerce this row to 'proposed' and make the cron path emit a
    // false "batch ready to sign" alert. Abort, alert, and return the real
    // 'failed' status for human triage. (Codex P2)
    if (row.status === 'failed' && row.safeProposalHash != null) {
      log.error(
        { cycleMonth, batchId: row.id, safeProposalHash: row.safeProposalHash },
        'cycle previously FAILED execution; manual on-chain verification required before any retry',
      );
      void alerts
        .alert(
          'batcher',
          `Rebate cycle ${cycleMonth} previously FAILED execution (Safe tx ${row.safeProposalHash}); recipients were NOT paid. Verify on-chain whether any transfer settled before deciding to re-propose — do NOT blindly re-trigger.`,
        )
        .catch((e) => log.warn({ err: e }, 'failed-cycle alert failed'));
      return {
        batchId: row.id,
        status: 'failed',
        safeTxHash: row.safeProposalHash,
        recipientCount: 0,
        poolWei: pool,
      };
    }

    // ABORT if this cycle already has a live/terminal Safe proposal —
    // re-proposing would queue a second Safe payout for the same month.
    if (
      row.safeProposalHash != null ||
      row.status === 'proposed' ||
      row.status === 'executed' ||
      row.status === 'no_recipients'
    ) {
      log.warn(
        { cycleMonth, batchId: row.id, status: row.status },
        'cycle already proposed/terminal; not re-proposing (no double-pay)',
      );
      const st = (['proposed', 'executed', 'no_recipients'].includes(row.status)
        ? row.status
        : 'proposed') as BatcherResult['status'];
      return {
        batchId: row.id,
        status: st,
        safeTxHash: row.safeProposalHash ?? null,
        recipientCount: 0,
        poolWei: pool,
      };
    }

    // RESUME a stuck pre-propose row ('computing'/'failed', no Safe proposal):
    // reuse it, refresh the pool/fee snapshot, and clear any stale entries so the
    // recompute below is clean. SAFE because the advisory lock (held since the top
    // of runBatcher) guarantees no other batcher is live, so this 'computing' row
    // is a crashed prior run — never a sibling mid-compute. (Codex P1)
    log.warn(
      { cycleMonth, batchId: row.id, status: row.status },
      'resuming incomplete cycle (recompute + re-propose)',
    );
    batchId = row.id;
    await db
      .update(schema.rebateBatches)
      .set({ status: 'computing', netFeeWethWei: netFee, poolWethWei: pool })
      .where(eq(schema.rebateBatches.id, batchId));
    await db.delete(schema.rebateBatchEntries).where(eq(schema.rebateBatchEntries.batchId, batchId));
  }

  // 4. Bail early when there is nothing to distribute. POOL mode: no wallets, or
  //    the pool rounds to 0. DIRECT mode: ONLY when the Safe is genuinely empty
  //    (netFee === 0) — if it holds WETH but no wallet qualifies, we must NOT stop
  //    here, or the balance stays in the fee Safe and is re-counted (re-rebated)
  //    next cycle; instead fall through so the 7b retention sweep moves it to the
  //    revenue address. (The stranded non-WETH probe in step 1b already alerted
  //    regardless of pool.) (Codex P2)
  if (directMode ? netFee === 0n : wallets.length === 0 || pool === 0n) {
    await db.update(schema.rebateBatches).set({ status: 'no_recipients' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.info(
      { batchId, directMode, reason: netFee === 0n ? 'empty safe' : pool === 0n ? 'zero pool' : 'no wallets' },
      'no recipients',
    );
    return { batchId, status: 'no_recipients', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 5. Compute the per-recipient WETH amounts. Two flag-selected models:
  //    - POOL (default): computeShares distributes POOL_SPLIT_BPS% of the Safe's
  //      WETH balance, weighted by volume*tier%.
  //    - DIRECT (REBATE_DIRECT_MODE): computeDirectRebates pays each wallet its
  //      tier% of its own fee-share of the FULL balance; Ophis keeps the rest,
  //      swept to the revenue address in step 7b. No pool.
  //    Both return Map<wallet, wei>; both feed the same empty-guard + dry-run.
  const shares = directMode ? computeDirectRebates(wallets, netFee) : computeShares(wallets, pool);

  // 6. Recipient transfers from the computed shares. The map is EMPTY when every
  //    tracked wallet is below the entry floor (tier 'none'); we do NOT early-
  //    return here — the all-unranked case is handled uniformly at 7b/7c (POOL ->
  //    no_recipients; DIRECT -> sweep the whole balance to revenue).
  const simulate = buildEthCallSimulator({ chainId: deps.chainId, rpcUrl: deps.rpcUrl });
  const revenueAddress = directMode ? getRevenueAddress() : null;
  const recipientTransfers: Transfer[] = [...shares.entries()].map(([to, amount]) => ({ to, amount }));

  // 6b. Dry-run + quarantine the recipients (skipped when there are none).
  const { good, bad }: { good: Transfer[]; bad: Transfer[] } =
    recipientTransfers.length > 0 ? await isolateBadRecipients(recipientTransfers, simulate) : { good: [], bad: [] };

  // 7. Per-recipient entries (good + bad, bad zeroed) — none when nobody qualified.
  if (recipientTransfers.length > 0) {
    const entryRows = recipientTransfers.map((t) => {
      const w = wallets.find((x) => x.wallet === t.to)!;
      const tier = assignTier(w.volume_30d_usd);
      const isBad = bad.some((b) => b.to === t.to);
      return {
        batchId,
        wallet: t.to,
        volumeUsd: w.volume_30d_usd.toFixed(4),
        tier: tier.name,
        rebatePct: tier.rebate_pct.toFixed(4),
        wethAmountWei: isBad ? 0n : t.amount,
      };
    });
    await db.insert(schema.rebateBatchEntries).values(entryRows);
  }

  // 7a. Recipients existed but EVERY one was quarantined by the dry-run -> genuine
  //     failure (bad addresses), distinct from "nobody qualified" (-> 7c). Not
  //     swept: a quarantine failure needs operator attention, not a silent sweep.
  if (recipientTransfers.length > 0 && good.length === 0) {
    // INVARIANT: this 'failed' is written with NO safe_proposal_hash (none exists
    // yet — propose runs below). That is what lets the duplicate-cycle handler
    // above disambiguate the two 'failed' meanings purely by hash presence:
    //   failed + NO hash  → all-quarantined here, no proposal queued  → RESUME;
    //   failed + hash     → a proposal executed and reverted (poll.ts) → ABORT (P2a).
    // Do NOT set a hash on this path, or a recoverable cycle would be wedged.
    await db.update(schema.rebateBatches).set({ status: 'failed' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.error({ batchId, badCount: bad.length }, 'all recipients quarantined');
    return { batchId, status: 'failed', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 7b. Build the multisend: good recipient rebates + the DIRECT-mode retention
  //     sweep of everything NOT paid out, so the fee Safe is emptied and the
  //     remainder is not re-counted/re-rebated next cycle. leftover = netFee -
  //     Σ(GOOD), so a quarantined recipient's unpaid amount is retained too, AND
  //     an all-unranked month (good=[]) sweeps the ENTIRE balance (Codex P2). POOL
  //     mode never sweeps (its floor-division dust stays in the Safe, unchanged).
  const proposedTransfers: Transfer[] = [...good];
  if (directMode) {
    const paidWei = good.reduce((sum, t) => sum + t.amount, 0n);
    const leftoverWei = netFee - paidWei;
    if (revenueAddress && leftoverWei > 0n) {
      // Fail closed if the revenue address can't receive WETH: proposing a
      // multisend that reverts on-chain would block the recipients' payouts too,
      // and silently dropping the sweep would forfeit retention.
      const { good: sweepGood } = await isolateBadRecipients([{ to: revenueAddress, amount: leftoverWei }], simulate);
      if (sweepGood.length === 0) {
        await db.update(schema.rebateBatches).set({ status: 'failed' })
          .where(eq(schema.rebateBatches.id, batchId));
        log.error({ batchId, revenueAddress }, 'direct-mode revenue address reverted on WETH transfer in dry-run; not proposing');
        void alerts
          .alert('batcher', `Direct-rebate cycle ${cycleMonth}: REBATE_REVENUE_ADDRESS ${revenueAddress} reverted on a WETH transfer in the dry-run. No proposal was queued; fix the address and re-run.`)
          .catch((e) => log.warn({ err: e }, 'bad-revenue-address alert failed'));
        return { batchId, status: 'failed', safeTxHash: null, recipientCount: good.length, poolWei: pool };
      }
      proposedTransfers.push({ to: revenueAddress, amount: leftoverWei });
      log.info({ batchId, leftoverWei: leftoverWei.toString(), recipientCount: good.length, revenueAddress }, 'direct-mode: sweeping retained margin to revenue address');
    } else if (!revenueAddress && leftoverWei > 0n) {
      log.warn({ batchId, leftoverWei: leftoverWei.toString() }, 'direct mode ON without REBATE_REVENUE_ADDRESS: leftover stays in the fee Safe (re-counted next cycle; not retained)');
      void alerts
        .alert('batcher', `Direct-rebate cycle ${cycleMonth}: no REBATE_REVENUE_ADDRESS set, so ${leftoverWei.toString()} wei WETH stays in the fee Safe and WILL be re-counted next cycle (no true retention). Set REBATE_REVENUE_ADDRESS to sweep it out.`)
        .catch((e) => log.warn({ err: e }, 'no-revenue-address alert failed'));
    }
  }

  // 7c. Nothing to move: POOL mode with no qualifying recipients, or DIRECT mode
  //     with no recipients and no sweep (no revenue address). Terminal
  //     no_recipients (NOT 'failed' -> the duplicate-cycle guard treats it as
  //     terminal and will not resume/recompute forever). (Codex P2 + post-floor)
  if (proposedTransfers.length === 0) {
    await db.update(schema.rebateBatches).set({ status: 'no_recipients' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.info({ batchId, walletCount: wallets.length, directMode }, 'no qualifying recipients (all tracked wallets below the entry floor; nothing to sweep)');
    return { batchId, status: 'no_recipients', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 8. Propose (unless deps.proposeEnabled is false — first-batch dry-run).
  if (!deps.proposeEnabled) {
    log.info({ batchId, recipientCount: good.length, poolWei: pool.toString() }, 'dry-run only, not proposing');
    return { batchId, status: 'computing', safeTxHash: null, recipientCount: good.length, poolWei: pool };
  }
  // The row stays 'computing' through proposeRebateBatch's LOCAL pre-submit work
  // (Safe init, RPC reads, tx build, hash, signing). It flips to 'proposing' only
  // inside onBeforeSubmit — fired immediately before the Safe Transaction Service
  // POST — so a transient RPC/config failure during pre-submit leaves the cycle
  // 'computing' and auto-resumable instead of wedged into manual verification.
  // `submitAttempted` is set ONLY after the row is durably 'proposing', so it is
  // true iff a submit could have queued a proposal (and our hash-write is not
  // atomic with it). (Codex P2)
  let submitAttempted = false;
  let safeTxHash: `0x${string}`;
  try {
    ({ safeTxHash } = await proposeRebateBatch({
      chainId: deps.chainId,
      rpcUrl: deps.rpcUrl,
      proposerPrivateKey: deps.proposerPrivateKey,
      transfers: proposedTransfers,
      onBeforeSubmit: async () => {
        await db.update(schema.rebateBatches).set({ status: 'proposing', proposedAt: new Date() })
          .where(eq(schema.rebateBatches.id, batchId));
        submitAttempted = true;
      },
    }));
  } catch (err) {
    if (submitAttempted) {
      // Failure AT/AFTER the Safe-service submit: the service may have accepted the
      // proposal before the connection dropped, yet we never persisted a hash. Row
      // is 'proposing' → the next run requires manual Safe-queue verification rather
      // than auto-re-proposing a possible duplicate. (Codex P2-3)
      log.error({ err, batchId, cycleMonth }, 'submit attempt failed; left as proposing for manual verification');
      void alerts
        .alert('batcher', `Rebate cycle ${cycleMonth} Safe submit attempt FAILED after the proposal was sent. A proposal may or may not exist — verify the Safe queue manually before retrying.`)
        .catch((e) => log.warn({ err: e }, 'submit-failed alert failed'));
    } else {
      // Failure during LOCAL pre-submit work: no proposal can have been queued. The
      // row is still 'computing' → the next run safely RESUMES (recompute +
      // re-propose), so a flaky RPC no longer wedges the month into manual-only.
      log.error({ err, batchId, cycleMonth }, 'pre-submit failed; cycle left computing for automatic resume');
      void alerts
        .alert('batcher', `Rebate cycle ${cycleMonth} failed BEFORE the Safe submit (no proposal queued); it will auto-resume on the next batcher run.`)
        .catch((e) => log.warn({ err: e }, 'pre-submit-failed alert failed'));
    }
    throw err;
  }
  await db.update(schema.rebateBatches).set({
    status: 'proposed',
    safeProposalHash: safeTxHash,
    proposedAt: new Date(),
  }).where(eq(schema.rebateBatches.id, batchId));

  // 9. Fire-and-forget polling for finality.
  waitForExecution({ chainId: deps.chainId, safeTxHash }).then(async (r) => {
    if (r.executed) {
      await db.update(schema.rebateBatches).set({
        status: r.isSuccessful ? 'executed' : 'failed',
        safeTxHash: r.transactionHash ?? undefined,
        executedAt: new Date(),
      }).where(eq(schema.rebateBatches.id, batchId));
    }
  }).catch((err) => log.error({ err, batchId }, 'polling failed'));

  return { batchId, status: 'proposed', safeTxHash, recipientCount: good.length, poolWei: pool };
}
