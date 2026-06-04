import { eq } from 'drizzle-orm';
import { sql, db, schema } from './db/index.js';
import { computeShares, type EligibleWallet } from './batch/computeShares.js';
import { computeDirectRebates } from './batch/computeDirectRebates.js';
import { buildEthCallSimulator, isolateBadRecipients, type Transfer } from './batch/dryRun.js';
import { proposeRebateBatch } from './batch/propose.js';
import { waitForExecution } from './batch/poll.js';
import { assignTier, POOL_SPLIT_BPS } from './tiers.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from './safe/addresses.js';
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
 * of its share of the NEW fees that accrued since the last cycle; the un-rebated
 * remainder stays in the fee Safe as profit and is never re-rebated). Default-OFF
 * so the live deploy is byte-identical until flipped; any other value throws.
 */
function resolveDirectMode(): boolean {
  const raw = process.env.REBATE_DIRECT_MODE?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`REBATE_DIRECT_MODE must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

/**
 * Parse the optional first-cycle accrual seed REBATE_FEE_BASIS_WEI (direct mode only,
 * consulted ONLY when no accounted direct cycle exists yet). Returns the seed, or
 * undefined when unset/empty or an explicit 0 (0 would rebate the ENTIRE balance —
 * rejected with a warn). THROWS on a SET-BUT-MALFORMED value (non-decimal: "1.5e18",
 * "0x10", "1_000", a negative, trailing junk) so a typo fails loudly instead of being
 * silently treated as "unset" and dropping the operator's intended baseline. Mirrors
 * resolveDirectMode's fail-closed parsing. The throw deliberately fail-CLOSES the
 * first direct cycle (the only one that reads the seed): the batcher defers and
 * Telegram-alerts the exact bad value (cron catch) until the operator fixes/unsets the
 * env and re-triggers — a bootstrap guard, never a silent wrong baseline. (P2-1)
 */
function parseFeeBasisSeed(): bigint | undefined {
  const raw = process.env.REBATE_FEE_BASIS_WEI?.trim();
  if (!raw) return undefined; // unset / empty: no seed
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `REBATE_FEE_BASIS_WEI is malformed: "${raw}" — must be decimal wei digits only (e.g. "1000000000000000000" for 1 WETH). Fix or unset it.`,
    );
  }
  const v = BigInt(raw);
  if (v === 0n) {
    log.warn('REBATE_FEE_BASIS_WEI=0 ignored (would rebate the entire balance); using the current balance as the first-cycle baseline instead');
    return undefined;
  }
  return v;
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
      // NULL this row's OWN basis on resume: a resumed row must never be read as its
      // own previous basis. The status-filtered basis read already excludes a
      // 'computing' row, but clear it explicitly so the "ignore my own basis on
      // recompute" invariant is local, not emergent from statement ordering. (sharp-edges MEDIUM-1)
      .set({ status: 'computing', netFeeWethWei: netFee, poolWethWei: pool, feeBasisWethWei: null })
      .where(eq(schema.rebateBatches.id, batchId));
    await db.delete(schema.rebateBatchEntries).where(eq(schema.rebateBatchEntries.batchId, batchId));
  }

  // 3b. DIRECT mode: rebate ONLY the NEW fees accrued since the last accounted
  //     cycle, so Ophis's retained profit stays IN the fee Safe and is never
  //     re-rebated. newFees = current balance - the basis recorded by the most
  //     recent ACCOUNTED cycle (executed/no_recipients; NULL or pending rows
  //     skipped). First-ever direct cycle: basis defaults to the CURRENT balance
  //     (rebates nothing, just sets the baseline) unless REBATE_FEE_BASIS_WEI seeds
  //     a lower one (0 is rejected — see below). POOL mode is unchanged:
  //     `distributable` is just the pool.
  let distributable = pool;
  if (directMode) {
    // Don't start a new direct cycle while a PRIOR payout is still pending
    // (proposed/proposing): its accrual basis only becomes final on execution, so
    // running now would double-count those not-yet-paid fees as new distributable
    // fees. Defer (leave this row 'computing', resume next run) until the prior
    // payout is signed/executed. (Codex P2)
    const pending = await sql<{ m: string }[]>`
      SELECT cycle_month::text AS m FROM rebate_batches
      WHERE status IN ('proposed', 'proposing') AND cycle_month <> ${cycleMonth} LIMIT 1
    `;
    if (pending.length > 0) {
      log.warn({ batchId, pendingCycle: pending[0]!.m }, 'a prior rebate payout is still pending; deferring this direct cycle');
      void alerts
        .alert('batcher', `Direct-rebate cycle ${cycleMonth} deferred: a prior payout (${pending[0]!.m}) is still proposed/proposing (unsigned). Sign/execute it first; this cycle stays 'computing' and resumes next run. If that payout was REJECTED/ABANDONED, reset its row before the next cycle — otherwise direct-mode accrual stays blocked indefinitely.`)
        .catch((e) => log.warn({ err: e }, 'pending-defer alert failed'));
      return { batchId, status: 'computing', safeTxHash: null, recipientCount: 0, poolWei: 0n };
    }
    // Previous basis = the most recent ACCOUNTED DIRECT cycle (executed payout or
    // no_recipients). Deliberately EXCLUDES 'proposed' rows (optimistic basis, correct
    // only once executed — the pending-guard guarantees we never read past one) and
    // POOL rows (NULL basis). `id` is fetched too, to detect a POOL payout since.
    const prev = await sql<{ id: number; b: string }[]>`
      SELECT id, fee_basis_weth_wei::text AS b FROM rebate_batches
      WHERE status IN ('executed', 'no_recipients') AND fee_basis_weth_wei IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `;
    // First-cycle seed: consulted ONLY when no accounted DIRECT cycle exists yet. A
    // seed BELOW the current balance intentionally rebates already-accrued historical
    // fees (loud alert below); 0 is rejected; a SET-BUT-MALFORMED value THROWS
    // (parseFeeBasisSeed, P2-1) rather than being silently treated as "unset" and
    // dropping the operator's intended baseline. (HIGH-2)
    let previousBasis: bigint;
    if (prev.length > 0) {
      previousBasis = BigInt(prev[0]!.b);
    } else {
      const envSeed = parseFeeBasisSeed(); // throws on a set-but-malformed value
      if (envSeed !== undefined) {
        previousBasis = envSeed;
        if (envSeed < netFee) {
          void alerts
            .alert('batcher', `Direct-rebate FIRST cycle ${cycleMonth} seeded BELOW the current balance (REBATE_FEE_BASIS_WEI): will rebate ${(netFee - envSeed).toString()} wei of ALREADY-ACCRUED fees, not just this month's accrual. Confirm this is intended.`)
            .catch((e) => log.warn({ err: e }, 'first-cycle-seed alert failed'));
        }
      } else {
        previousBasis = netFee; // unset / 0-rejected -> baseline = current balance (rebate nothing this cycle)
      }
    }
    // Re-baseline a STALE basis. The direct basis only tracks DIRECT payouts, so it is
    // stale if, since it was recorded, either (a) a POOL-mode payout executed (POOL
    // rows keep a NULL basis and never update it), or (b) the balance otherwise fell
    // below it (a manual Safe withdrawal). In both cases the balance no longer relates
    // to the recorded mark, so treat the current balance as a FRESH baseline (rebate
    // nothing this transition cycle) and alert — otherwise the recovery toward a stale
    // mark is mis-counted as new fees (over- OR under-rebate, in either direction).
    // Gated on directMode, so pure pool mode is unaffected. (P2-3)
    const poolPaidSince =
      prev.length > 0 &&
      (
        await sql<{ one: number }[]>`
          SELECT 1 AS one FROM rebate_batches
          WHERE fee_basis_weth_wei IS NULL AND status = 'executed' AND pool_weth_wei > 0 AND id > ${prev[0]!.id}
          LIMIT 1
        `
      ).length > 0;
    if (poolPaidSince || netFee < previousBasis) {
      log.warn(
        { batchId, previousBasisWei: previousBasis.toString(), balanceWei: netFee.toString(), poolPaidSince },
        'stale direct basis (pool payout or withdrawal since last direct cycle); re-baselining to current balance',
      );
      void alerts
        .alert('batcher', `Direct-rebate cycle ${cycleMonth}: the recorded basis (${previousBasis.toString()} wei) is stale — ${poolPaidSince ? 'a POOL-mode payout executed' : 'the Safe balance fell below it (a withdrawal)'} since the last direct cycle. Re-baselining to the current balance (${netFee.toString()} wei); fees that arrived in the gap are absorbed (seed REBATE_FEE_BASIS_WEI to capture them). Avoid toggling REBATE_DIRECT_MODE mid-program.`)
        .catch((e) => log.warn({ err: e }, 'basis-rebaseline alert failed'));
      previousBasis = netFee;
    }
    distributable = netFee > previousBasis ? netFee - previousBasis : 0n;
    log.info(
      { batchId, balanceWei: netFee.toString(), previousBasisWei: previousBasis.toString(), newFeesWei: distributable.toString() },
      'direct-mode accrual basis',
    );
    // Persist the recomputed distributable so /status, /batches and the reconciler
    // report this direct cycle's real pool (newFees), not the stale 50%-of-balance
    // value written at insert. Direct-mode only (gated); POOL rows keep their pool. (P2-2)
    await db.update(schema.rebateBatches).set({ poolWethWei: distributable }).where(eq(schema.rebateBatches.id, batchId));
  }

  // 4. Nothing to distribute -> terminal no_recipients. POOL: no wallets / zero
  //    pool. DIRECT: no NEW fees since last cycle. In DIRECT mode advance the basis
  //    to the current balance so any new-but-unpaid fees (e.g. rounding dust) are
  //    kept as profit, not re-rebated. (The stranded non-WETH probe in step 1b
  //    already alerted regardless of pool.)
  if (directMode ? distributable === 0n : wallets.length === 0 || pool === 0n) {
    await db.update(schema.rebateBatches)
      .set({ status: 'no_recipients', ...(directMode ? { feeBasisWethWei: netFee } : {}) })
      .where(eq(schema.rebateBatches.id, batchId));
    log.info(
      { batchId, directMode, reason: directMode ? 'no new fees' : pool === 0n ? 'zero pool' : 'no wallets' },
      'no recipients',
    );
    return { batchId, status: 'no_recipients', safeTxHash: null, recipientCount: 0, poolWei: distributable };
  }

  // 5. Compute the per-recipient WETH amounts: POOL weights vs DIRECT (each wallet
  //    gets its tier% of its share of the NEW fees). Both return Map<wallet, wei>.
  const shares = directMode ? computeDirectRebates(wallets, distributable) : computeShares(wallets, pool);

  // 5b. No QUALIFYING recipients: tracked wallets exist and the pool is nonzero,
  //     but every wallet is below the entry floor (tier 'none' = zero weight), so
  //     computeShares dropped them all. This became reachable when the $20k Bronze
  //     floor was introduced (before that, any volume > 0 earned >= 10% weight).
  //     Record terminal 'no_recipients' and bail BEFORE the empty-transfer path:
  //     an empty batch must not (a) attempt an empty entry insert, nor (b) fall
  //     into the `good.length === 0` branch and be recorded as 'failed' (no hash) —
  //     which the duplicate-cycle guard would RESUME and recompute the same empty
  //     result every run, wedging the cycle. (Codex P2, post-floor)
  if (shares.size === 0) {
    // DIRECT mode: new fees arrived but no wallet qualified (all below the floor)
    // -> keep them as profit by advancing the basis to the current balance.
    await db.update(schema.rebateBatches)
      .set({ status: 'no_recipients', ...(directMode ? { feeBasisWethWei: netFee } : {}) })
      .where(eq(schema.rebateBatches.id, batchId));
    log.info({ batchId, walletCount: wallets.length, directMode }, 'no qualifying recipients (all tracked wallets below the entry floor)');
    return { batchId, status: 'no_recipients', safeTxHash: null, recipientCount: 0, poolWei: distributable };
  }

  const transfersAll: Transfer[] = [...shares.entries()].map(([to, amount]) => ({ to, amount }));

  // 6. Dry-run + quarantine.
  const simulate = buildEthCallSimulator({ chainId: deps.chainId, rpcUrl: deps.rpcUrl });
  const { good, bad } = await isolateBadRecipients(transfersAll, simulate);

  // 7. Write per-wallet entries (good + bad, with bad amounts zeroed).
  const entryRows = transfersAll.map((t) => {
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

  if (good.length === 0) {
    // INVARIANT: this 'failed' is written with NO safe_proposal_hash (none exists
    // yet — propose runs below). That is what lets the duplicate-cycle handler
    // above disambiguate the two 'failed' meanings purely by hash presence:
    //   failed + NO hash  → all-quarantined here, no proposal queued  → RESUME;
    //   failed + hash     → a proposal executed and reverted (poll.ts) → ABORT (P2a).
    // Do NOT set a hash on this path, or a recoverable cycle would be wedged.
    await db.update(schema.rebateBatches).set({ status: 'failed' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.error({ batchId, badCount: bad.length }, 'all recipients quarantined');
    return { batchId, status: 'failed', safeTxHash: null, recipientCount: 0, poolWei: distributable };
  }

  // DIRECT mode basis accounting. `paidWei` = the rebates actually proposed for payout
  // (good recipients only). The basis advances by `paidWei` (below), so it equals the
  // TRUE post-payout Safe balance (Safe MultiSend is atomic — exactly `good` leaves). A
  // quarantined (bad) recipient's earned-but-unpaid rebate stays in the Safe BELOW the
  // next basis and is NOT redistributed to other wallets next cycle. (Codex post-merge
  // P2-4: the prior "defer ABOVE the basis" silently misattributed it to whoever had
  // volume next cycle, which may not include the quarantined wallet.) Each quarantined
  // recipient is surfaced per-recipient below so ops can retry/clear it — WETH has no
  // transfer hook, so quarantine is near-impossible in practice.
  const paidWei = good.reduce((sum, t) => sum + t.amount, 0n);
  if (directMode && bad.length > 0) {
    const quarantinedWei = bad.reduce((sum, t) => sum + t.amount, 0n);
    log.warn(
      { batchId, badCount: bad.length, quarantinedWei: quarantinedWei.toString(), paidWei: paidWei.toString() },
      'direct-mode: quarantined recipients NOT paid; owed amounts stay in the Safe (not redistributed to others)',
    );
    // One capped alert (mirrors the stranded-token cap) rather than N sends, so a
    // pathological mass-quarantine can't flood Telegram. Addresses are 0x-hex (safe).
    const shown = bad
      .slice(0, MAX_ALERT_TOKENS)
      .map((b) => `<code>${b.to}</code> (${b.amount.toString()} wei)`)
      .join(', ');
    const detail = bad.length > MAX_ALERT_TOKENS ? `${shown}, +${bad.length - MAX_ALERT_TOKENS} more` : shown;
    void alerts
      .alert('batcher', `Direct-rebate cycle ${cycleMonth}: ${bad.length} recipient(s) QUARANTINED (transfer reverted at dry-run); their owed rebate was NOT paid and stays in the Safe (NOT auto-redistributed): ${detail}. Retry them or clear from tracking.`)
      .catch((err) => log.warn({ err }, 'quarantine alert failed'));
  }

  // 8. Propose (unless deps.proposeEnabled is false — first-batch dry-run).
  if (!deps.proposeEnabled) {
    log.info({ batchId, recipientCount: good.length, distributableWei: distributable.toString() }, 'dry-run only, not proposing');
    return { batchId, status: 'computing', safeTxHash: null, recipientCount: good.length, poolWei: distributable };
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
      transfers: good,
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
    // DIRECT mode: record the accrual basis = balance - rebates PAID = the TRUE
    // post-payout Safe balance (Safe MultiSend is atomic, so exactly `good` leaves). A
    // quarantined recipient's unpaid rebate stays in the Safe BELOW this basis and is
    // NOT redistributed next cycle (surfaced per-recipient above for manual retry). The
    // status-filtered read + the pending-guard ensure this is only read once the payout
    // settles (skipped if it reverts). (Codex post-merge P2-4; sharp-edges CRITICAL-1/2)
    ...(directMode ? { feeBasisWethWei: netFee - paidWei } : {}),
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

  return { batchId, status: 'proposed', safeTxHash, recipientCount: good.length, poolWei: distributable };
}
