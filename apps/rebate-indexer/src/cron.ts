import cron from 'node-cron';
import { runFetcher, pruneStaleWallets, withPipelineLock } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher, isFirstOfMonth } from './batcher.js';
import { reconcileBatches } from './batch/reconcile.js';
import { deliverMonthlyReport } from './affiliate/deliverReport.js';
import { runAffiliatePayout, reconcileAffiliateBatches } from './affiliate/payout.js';
import { resolveAffiliatePayoutEnabled } from './affiliate/payoutPlan.js';
import { OWN_FEE_GUARANTEED_CHAIN_IDS } from './affiliate/rates.js';
import { accrueOwnFee, proposeOwnFeeBatches, reconcileOwnFeeBatches } from './ownFee/payout.js';
import { resolveOwnFeePayoutEnabled } from './ownFee/payoutPlan.js';
import { runPartnerFeeFetch } from './partnerFees/fetch.js';
import { runPartnerFeePricer } from './partnerFees/pricePartnerFees.js';
import { accruePartnerFees, proposePartnerFeeBatches, reconcilePartnerFeeBatches, resolvePartnerFeePayoutEnabled } from './partnerFees/payout.js';
import { alerts } from './telegram/alerter.js';
import { logger } from './logger.js';
import { sql } from './db/index.js';

const log = logger.child({ module: 'cron' });

function gnosisRpc(): string {
  return process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
}

// Sovereign chains that pay per-recipient own-fee (each from its OWN chain's Ophis Safe).
const SOVEREIGN_OWN_FEE_CHAINS = [...OWN_FEE_GUARANTEED_CHAIN_IDS];
// Keyless public defaults; override per chain via OWN_FEE_RPC_URL_<id> (or the existing
// SETTLE_RPC_URL_<id> the settle decoder already uses).
const SOVEREIGN_RPC_DEFAULT: Record<number, string> = {
  10: 'https://mainnet.optimism.io',
  130: 'https://mainnet.unichain.org',
};
function ownFeeRpc(chainId: number): string {
  return (
    process.env[`OWN_FEE_RPC_URL_${chainId}`] ??
    process.env[`SETTLE_RPC_URL_${chainId}`] ??
    SOVEREIGN_RPC_DEFAULT[chainId] ??
    'https://mainnet.optimism.io'
  );
}

/**
 * Global dry-run switch for the monthly Safe proposals (rebate batcher, affiliate
 * payout, own-fee proposal). Default-ON (unset/''/'true'/'1' => propose) so live
 * behavior is unchanged; 'false'/'0' => dry-run only. Any OTHER value THROWS
 * (fail-loud) instead of silently proposing, so a typo like 'False'/'no'/'off'
 * can never be misread as "propose real money". Same fail-loud parser shape as
 * resolveDirectMode/resolveAffiliatePayoutEnabled/resolveOwnFeePayoutEnabled — this
 * one just defaults ON rather than OFF. A money-path flag must never fail OPEN on an
 * ambiguous value.
 */
export function resolveBatcherProposeEnabled(): boolean {
  const raw = process.env.BATCHER_PROPOSE_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`BATCHER_PROPOSE_ENABLED must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

/**
 * True when THIS calendar month's batcher step already completed: the heartbeat writes a
 * first_of_month=true pipeline_runs row ONLY when runBatcher actually executed (any result),
 * never on a skip/fail-closed cycle -- which is exactly what makes it a retry gate.
 */
async function batcherRanThisMonth(): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pipeline_runs WHERE first_of_month AND ran_at >= date_trunc('month', now())) AS ok
  `;
  return row?.ok ?? false;
}

/**
 * The full nightly pipeline. Runs sequentially. Called by the daily cron tick.
 * On the 1st of the month, batcher runs as the final step — never as a separate
 * cron entry, eliminating the race noted in the spec §"Safe batch flow → Step 1".
 */
// The actual pipeline steps. Always invoked via runNightlyPipeline (under the
// pipeline advisory lock); never call this directly or you reintroduce the race
// with the startup backfill.
async function runPipelineSteps(): Promise<void> {
  const { inserted } = await runFetcher();
  log.info({ inserted }, 'fetcher complete');

  // Registry maintenance — nightly only (never inside runFetcher / the replay
  // loop). Evicts spam wallets that will never yield a rebate; keeps proven
  // wallets and any still being retried.
  const { pruned } = await pruneStaleWallets();
  log.info({ pruned }, 'prune complete');

  const priced = await runPricer();
  log.info(priced, 'pricer complete');

  const scored = await runScorer();
  log.info(scored, 'scorer complete');

  // Partner-fee accrual feed (partner-fees Phase B): pull new fee-bearing trades from the
  // restricted feed and price their collected fee. Nightly, like the main pricer; the monthly
  // batcher (below) consumes the priced trades. Wrapped so a restricted-feed / pricing outage
  // never breaks the main pipeline (the feature is inert until PARTNER_FEE_FEED_URLS is set).
  // BUT the failure is NOT swallowed for money purposes: partnerFeedOk feeds the 1st-of-month
  // fail-closed guard below -- a feed the fetcher could not drain (or rows the pricer left
  // unpriced) means the partner liability would silently UNDER-count, and the shared-Safe
  // rebate/affiliate distribution must not run against it. (Accrual itself also fail-louds on
  // in-scope unpriced/un-timestamped rows, which covers backlogs from earlier nights.)
  let partnerFeedOk = true;
  try {
    const pf = await runPartnerFeeFetch();
    const pfp = await runPartnerFeePricer();
    if (pfp.failed > 0) {
      partnerFeedOk = false;
      log.error({ priceFailed: pfp.failed }, 'partner-fee pricer left rows unpriced; the 1st-of-month shared-Safe distribution fails closed until they price');
    }
    // A SKIPPED (ambiguous) attribution is dropped fees for real partners on that row -- the
    // cursor advances past it, so no later query can see the absence. Tonight's skips fail the
    // cycle closed like unpriced rows do; a mid-month skip is surfaced by the fetch-time capped
    // alert and MUST be resolved (re-cursor or manual accounting) before month-end -- it cannot
    // be re-detected here once its night has passed.
    if (pf.skipped > 0) {
      partnerFeedOk = false;
      log.error({ skipped: pf.skipped }, 'partner-fee fetch skipped ambiguous attributions; the 1st-of-month shared-Safe distribution fails closed (fees dropped from the feed)');
    }
    // A page-capped run drained only a PREFIX of the feed: accruing it would under-count the
    // liability exactly like unpriced rows would. Fails the cycle closed; the fetch resumes
    // from its cursor next night and the (retried) monthly section completes once drained.
    if (pf.capped) {
      partnerFeedOk = false;
      log.error('partner-fee fetch hit its per-run page cap with pages remaining; the 1st-of-month shared-Safe distribution fails closed until the feed drains');
    }
    log.info({ fetched: pf.inserted, skipped: pf.skipped, priced: pfp.priced, priceFailed: pfp.failed }, 'partner-fee fetch+price complete');
  } catch (err) {
    partnerFeedOk = false;
    log.error({ err }, 'partner-fee fetch/price failed (non-fatal to the rest of the pipeline; the 1st-of-month shared-Safe distribution fails closed)');
  }

  // tierer.ts has no batch refresh — it's read-on-demand. Nothing to call here.

  // Reconcile open Safe batches EVERY night (independent of the 1st-of-month
  // batcher): heals 'proposed' rows whose in-process execution poller was lost to
  // a restart, nags unsigned batches, and surfaces stuck 'proposing' rows. It only
  // READS the Safe service + writes terminal status/alerts — it never proposes or
  // pays — so a failure here is non-fatal and must NOT abort the pipeline or block
  // the batcher below. (Runs before the batcher so last cycle is closed out first.)
  try {
    const rec = await reconcileBatches({ chainId: 100 });
    log.info(rec, 'reconcile complete');
    // Same nightly heal for affiliate batches (separate table, same Safe service).
    const arec = await reconcileAffiliateBatches({ chainId: 100 });
    log.info(arec, 'affiliate reconcile complete');
    // Same nightly heal for sovereign own-fee batches (separate table; each row polls
    // the Safe service on its OWN chain 10/130). Read-only, so also safe to run always.
    const ofrec = await reconcileOwnFeeBatches({});
    log.info(ofrec, 'own-fee reconcile complete');
    // Same nightly heal for partner-fee batches (separate table, same Gnosis Safe service).
    const pfrec = await reconcilePartnerFeeBatches({});
    log.info(pfrec, 'partner-fee reconcile complete');
  } catch (err) {
    log.error({ err }, 'reconcile failed (non-fatal; observability only)');
    await alerts.alert('reconcile', `Nightly batch reconciliation failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }

  // Telegram summary.
  const newTradesRows = await sql<{ new_trades: string }[]>`
    SELECT COUNT(*)::text AS new_trades FROM trades WHERE fetched_at > now() - INTERVAL '1 day'
  `;
  const volumeRows = await sql<{ volume: string | null }[]>`
    SELECT COALESCE(SUM(value_usd)::text, '0') AS volume FROM trades WHERE fetched_at > now() - INTERVAL '1 day'
  `;
  const new_trades = newTradesRows[0]?.new_trades ?? '0';
  const volume = volumeRows[0]?.volume ?? '0';
  await alerts.nightlyComplete({ newTrades: parseInt(new_trades, 10), volumeUsd: parseFloat(volume ?? '0') });

  // Tracks whether the monthly batcher STEP actually executed this run — NOT
  // merely that it is the 1st. A skipped batcher (e.g. missing proposer key)
  // must NOT advance /health.last_batcher_run_at, or the signal would claim the
  // batcher ticked while masking the very missed batch it exists to expose.
  let batcherRan = false;
  // Hoisted out of the first-of-month block: the NIGHTLY partner-fee proposal retry (below)
  // gates on it too. On non-1st days it stays true (no accrual ran to invalidate it).
  let partnerAccrualOk = true;
  // The monthly section runs on the 1st -- OR on any later night while THIS month's batcher
  // step has not yet completed (no first_of_month=true pipeline_runs row this month). That
  // row is written ONLY when runBatcher actually executed, so a 1st that failed closed (feed
  // outage), was skipped (lock contention, missing key), or never ran (host down) is RETRIED
  // the next night instead of silently deferring the whole shared-Safe cycle a month. Every
  // step inside is cycle-idempotent: accruals re-run while 'computed', runBatcher resumes or
  // aborts an already-proposed cycle, and proposals fire at most once per batch.
  const monthlyDue = isFirstOfMonth() || !(await batcherRanThisMonth());
  if (monthlyDue) {
    if (!isFirstOfMonth()) log.warn('monthly batcher step missing for this month; running CATCH-UP monthly section tonight');
    log.info('first-of-month: running batcher');
    // Sovereign own-fee ACCRUAL (phase A). Runs FIRST, flag-INDEPENDENT and proposer-key
    // -INDEPENDENT: it records the owed ledger to a 'computed' batch per sovereign chain
    // (10/130) so nothing is ever lost while the payout flag or the proposer key are off.
    // It reads no Safe balance and proposes nothing. Kept outside the proposer-key branch
    // (a missing key must not skip accrual) and before the batcher so the current cycle's
    // batch already exists for a same-run proposal. Wrapped per chain so one failure never
    // blocks the rest of the cycle.
    for (const chainId of SOVEREIGN_OWN_FEE_CHAINS) {
      try {
        await accrueOwnFee({ chainId });
      } catch (err) {
        log.error({ err, chainId }, 'own-fee accrual failed (non-fatal to the rest of the cycle)');
      }
    }
    // Partner-fee ACCRUAL (partner-fees Phase B) — MUST run FIRST, BEFORE the rebate batcher
    // and affiliate payout (money-correctness): it records this cycle's partner-owed ledger,
    // which is the outstanding liability those two batchers SUBTRACT to avoid paying the same
    // WETH twice. Flag- AND proposer-key-INDEPENDENT (records the ledger regardless). If it
    // THROWS, we FAIL CLOSED: the rebate batcher AND affiliate payout are SKIPPED this cycle,
    // because both distribute the SAME Ophis Safe and, without an up-to-date partner liability,
    // could pay out WETH owed to partners. Own-fee (a separate sovereign Safe) is unaffected.
    // The guard covers the WHOLE ingestion->accrual chain, not just accruePartnerFees: a feed
    // the fetcher could not drain tonight means trades may be MISSING entirely (undetectable
    // by accrual), so partnerFeedOk fails the cycle closed too. Accrual still RUNS on a bad
    // feed night -- it records what is known, is idempotent while 'computed', and a pipeline
    // re-trigger after the feed heals re-accrues the full month before anything distributes.
    partnerAccrualOk = partnerFeedOk;
    if (!partnerFeedOk) {
      log.error('partner-fee feed/pricing incomplete on the 1st; fail-closed: SKIPPING the rebate batcher + affiliate payout this cycle');
      await alerts.alert('partner-fee', 'Partner-fee feed fetch/pricing INCOMPLETE on the 1st. FAIL-CLOSED: the rebate batcher AND affiliate payout are SKIPPED this cycle (the partner liability could under-count missing/unpriced trades). Fix the feed/pricer and re-trigger the pipeline.').catch(() => {});
    }
    try {
      await accruePartnerFees({});
    } catch (err) {
      partnerAccrualOk = false;
      log.error({ err }, 'partner-fee accrual FAILED; fail-closed: SKIPPING the rebate batcher + affiliate payout this cycle (shared Safe must not be distributed against a stale/absent partner liability)');
      await alerts.alert('partner-fee', 'Partner-fee accrual FAILED on the 1st. FAIL-CLOSED: the rebate batcher AND affiliate payout are SKIPPED this cycle (they share the Ophis Safe and could otherwise spend WETH owed to partners against a stale/absent liability). Fix accrual and re-trigger the pipeline.').catch(() => {});
    }
    const proposeEnabled = resolveBatcherProposeEnabled();
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
    if (!proposerKey) {
      log.error('SAFE_PROPOSER_PRIVATE_KEY missing; skipping batcher');
      await alerts.alert('batcher', 'SAFE_PROPOSER_PRIVATE_KEY env var missing — no proposal made');
    } else {
      // Shared-Safe distribution (rebate + affiliate) runs ONLY when partner accrual
      // succeeded (fail-closed): both draw from the same Ophis Safe and must never distribute
      // it against a stale/absent partner liability.
      if (partnerAccrualOk) {
        const result = await runBatcher({
          chainId: 100,
          rpcUrl: gnosisRpc(),
          proposerPrivateKey: proposerKey as `0x${string}`,
          proposeEnabled,
        });
        batcherRan = true; // batcher executed (any result: proposed / no_recipients / dry-run)
        if (result.status === 'proposed') {
          await alerts.batchReady({
            cycle: new Date().toISOString().slice(0, 7),
            pool: (Number(result.poolWei) / 1e18).toFixed(5),
            count: result.recipientCount,
            safeQueueUrl: 'https://app.safe.global/transactions/queue?safe=gno:0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
            topRecipient: 'see /batches/' + result.batchId,
          });
        }
        // Affiliate payout: runs AFTER the rebate batcher (it reads this cycle's
        // rebate pool for the double-spend guard) and is independently flag-gated
        // (AFFILIATE_PAYOUT_ENABLED, default OFF). A separate Safe MultiSend at the
        // next free nonce; execution still needs the 2-of-3 signature. Wrapped so a
        // payout failure never blocks the report or the heartbeat.
        if (resolveAffiliatePayoutEnabled()) {
          try {
            await runAffiliatePayout({ chainId: 100, rpcUrl: gnosisRpc(), proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled });
          } catch (err) {
            log.error({ err }, 'affiliate payout failed (non-fatal to the rest of the cycle)');
          }
        }
      } else {
        log.error('skipping rebate batcher + affiliate payout this cycle: partner accrual failed (fail-closed, shared Safe)');
      }
      // Sovereign per-recipient own-fee PROPOSAL (phase B). Needs the proposer key
      // (this branch) AND OWN_FEE_PAYOUT_ENABLED (default OFF). Accrual (phase A) ran
      // above, flag- and key-independent, so the current cycle's 'computed' batch
      // already exists here. Proposes EVERY un-proposed 'computed' batch (current cycle
      // AND any back-months a previously-off flag/key left behind), each a SEPARATE Safe
      // MultiSend on ITS OWN sovereign chain from that chain's Ophis Safe; execution
      // still needs the 2-of-3 signature. Wrapped per chain so one failure never blocks
      // the other, the report, or the heartbeat.
      if (resolveOwnFeePayoutEnabled()) {
        for (const chainId of SOVEREIGN_OWN_FEE_CHAINS) {
          try {
            await proposeOwnFeeBatches({ chainId, rpcUrl: ownFeeRpc(chainId), proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled });
          } catch (err) {
            log.error({ err, chainId }, 'own-fee proposal failed (non-fatal to the rest of the cycle)');
          }
        }
      }
    }
    // Monthly settlement report — runs AFTER the batcher + affiliate payout so it
    // reflects this cycle's numbers. Self-contained + fire-and-forget (alerts on
    // failure, never throws), so a report hiccup can never block the heartbeat below.
    await deliverMonthlyReport({ rpcUrl: gnosisRpc() });
  }

  // Partner-fee PROPOSAL (partner-fees Phase B) — NIGHTLY, not first-of-month-only. Needs
  // PARTNER_FEE_PAYOUT_ENABLED (default OFF) + the proposer key. proposePartnerFeeBatches
  // proposes EVERY un-proposed 'computed' batch (each at most once), so a batch left behind by
  // an underfunded Safe, a transient pre-submit failure, an ambiguous-submission stop, or a
  // flag flipped mid-month is retried the NEXT NIGHT instead of waiting for the next 1st.
  // ACCRUAL stays monthly (above). Gated on partnerAccrualOk so the 1st never proposes against
  // a failed/incomplete accrual; on other nights it is trivially true. Its over-draw guard
  // reserves the already-queued rebate/affiliate proposals, the mirror of their reservation of
  // the partner liability. Wrapped so a failure never blocks the heartbeat. (On the 1st this
  // runs after deliverMonthlyReport; the report reads point-in-time stats, so ordering is
  // cosmetic.)
  if (partnerAccrualOk && resolvePartnerFeePayoutEnabled()) {
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
    if (!proposerKey) {
      log.error('SAFE_PROPOSER_PRIVATE_KEY missing; skipping the nightly partner-fee proposal');
      await alerts.alert('partner-fee', 'PARTNER_FEE_PAYOUT_ENABLED is on but SAFE_PROPOSER_PRIVATE_KEY is missing — no partner-fee proposal made.').catch(() => {});
    } else {
      try {
        await proposePartnerFeeBatches({ rpcUrl: gnosisRpc(), proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled: resolveBatcherProposeEnabled() });
      } catch (err) {
        log.error({ err }, 'partner-fee proposal failed (non-fatal; retried next night)');
      }
    }
  }

  // Durable nightly-completion heartbeat — LAST, so a row means the whole
  // pipeline ran to completion. Written only here (the cron path), never by the
  // startup backfill, so /health can witness the 02:00 UTC tick without the
  // admin-gated /status and a redeploy can't clobber it. The first_of_month
  // column is set ONLY when the batcher STEP actually ran (batcherRan), so
  // /health.last_batcher_run_at reflects real batcher executions, not skips.
  await sql`INSERT INTO pipeline_runs (first_of_month) VALUES (${batcherRan})`;
}

export async function runNightlyPipeline(): Promise<void> {
  const t0 = Date.now();
  log.info('pipeline start');

  try {
    // Hold the pipeline lock for the whole run so the non-blocking startup
    // backfill (index.ts) can't run concurrently and leave the batcher reading a
    // half-updated `wallets` matview on the 1st.
    const ran = await withPipelineLock(runPipelineSteps);
    if (!ran && isFirstOfMonth()) {
      // Skipping on any other day just defers a fetch by 24h — harmless. On the
      // 1st it could defer the monthly Safe proposal, so surface it loudly; a
      // manual re-trigger is safe and recovers a stuck cycle: runBatcher RESUMES
      // a 'computing'/'failed' row that never proposed, and ABORTS (no double-pay)
      // if the cycle was already proposed/terminal.
      log.error('nightly pipeline skipped on the 1st — another run held the lock; monthly batch may be deferred');
      await alerts.alert('batcher', 'Nightly pipeline skipped on the 1st (another run held the pipeline lock); the monthly rebate batch may be deferred. Verify the Safe queue or re-trigger.');
    }
  } catch (err: any) {
    log.error({ err: err?.message ?? err }, 'pipeline failed');
    await alerts.alert('pipeline', String(err?.message ?? err));
    throw err;
  }
  log.info({ ms: Date.now() - t0 }, 'pipeline complete');
}

export function startCron(): void {
  // 02:00 UTC daily. node-cron uses the host TZ — explicitly force UTC.
  cron.schedule('0 2 * * *', () => {
    runNightlyPipeline().catch(() => { /* already logged + alerted */ });
  }, { timezone: 'UTC' });
  log.info('cron scheduled: 02:00 UTC daily');
}
