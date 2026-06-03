import cron from 'node-cron';
import { runFetcher, pruneStaleWallets, withPipelineLock } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher, isFirstOfMonth } from './batcher.js';
import { alerts } from './telegram/alerter.js';
import { logger } from './logger.js';
import { sql } from './db/index.js';

const log = logger.child({ module: 'cron' });

function gnosisRpc(): string {
  return process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
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
