import cron from 'node-cron';
import { runFetcher } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher, isFirstOfMonth } from './batcher.js';
import { alerts } from './telegram/alerter.js';
import { logger } from './logger.js';
import { sql } from './db/index.js';
import { createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';

const log = logger.child({ module: 'cron' });

function gnosisRpc(): string {
  return process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
}

async function blockTimestampLookup(_chainId: number, blockNumber: number): Promise<Date> {
  // For Phase 1 we only block-fetch on Gnosis. Other chains: rely on CoW's API timestamps
  // (we accept a 1-day clock-skew worst case; rebate window is 30 days).
  const client = createPublicClient({ chain: gnosis, transport: http(gnosisRpc()) });
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  return new Date(Number(block.timestamp) * 1_000);
}

/**
 * The full nightly pipeline. Runs sequentially. Called by the daily cron tick.
 * On the 1st of the month, batcher runs as the final step — never as a separate
 * cron entry, eliminating the race noted in the spec §"Safe batch flow → Step 1".
 */
export async function runNightlyPipeline(): Promise<void> {
  const t0 = Date.now();
  log.info('pipeline start');

  try {
    const { inserted } = await runFetcher({ blockTimestampLookup });
    log.info({ inserted }, 'fetcher complete');

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
