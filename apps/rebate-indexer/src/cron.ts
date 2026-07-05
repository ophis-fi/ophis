import cron from 'node-cron';
import { runFetcher, pruneStaleWallets, withPipelineLock } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher, isFirstOfMonth } from './batcher.js';
import { reconcileBatches } from './batch/reconcile.js';
import { deliverMonthlyReport } from './affiliate/deliverReport.js';
import { runAffiliatePayout, reconcileAffiliateBatches } from './affiliate/payout.js';
import { resolveAffiliatePayoutEnabled } from './affiliate/payoutPlan.js';
import { accrueOwnFee, proposeOwnFeeBatches, reconcileOwnFeeBatches } from './ownFee/payout.js';
import { resolveOwnFeePayoutEnabled } from './ownFee/payoutPlan.js';
import { alerts } from './telegram/alerter.js';
import { logger } from './logger.js';
import { sql } from './db/index.js';

const log = logger.child({ module: 'cron' });

function gnosisRpc(): string {
  return process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
}

// Sovereign chains that pay per-recipient own-fee (each from its OWN chain's Ophis Safe).
const SOVEREIGN_OWN_FEE_CHAINS = [10, 130] as const;
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
  if (isFirstOfMonth()) {
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
    const proposeEnabled = process.env.BATCHER_PROPOSE_ENABLED !== 'false';
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
    if (!proposerKey) {
      log.error('SAFE_PROPOSER_PRIVATE_KEY missing; skipping batcher');
      await alerts.alert('batcher', 'SAFE_PROPOSER_PRIVATE_KEY env var missing — no proposal made');
    } else {
      const result = await runBatcher({
        chainId: 100,
        rpcUrl: gnosisRpc(),
        proposerPrivateKey: proposerKey as `0x${string}`,
        proposeEnabled,
      });
      batcherRan = true; // batcher executed (any result — proposed / no_recipients / dry-run)
      if (result.status === 'proposed') {
        await alerts.batchReady({
          cycle: new Date().toISOString().slice(0, 7),
          pool: (Number(result.poolWei) / 1e18).toFixed(5),
          count: result.recipientCount,
          safeQueueUrl: 'https://app.safe.global/transactions/queue?safe=gno:0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
          topRecipient: 'see /batches/' + result.batchId,
        });
      }
      // Affiliate payout — runs AFTER the rebate batcher (it reads this cycle's
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
