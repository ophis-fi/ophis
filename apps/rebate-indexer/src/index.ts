import { runMigrations } from './db/migrate.js';
import { startApi } from './api.js';
import { startCron } from './cron.js';
import { FETCHER_MAX_OWNERS_PER_RUN, runFetcher, withPipelineLock } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { logger } from './logger.js';
import { completeDefiLlamaBackfillIfReady } from './defillamaBackfill.js';
import { repairRouterTrades } from './repair/routerTrades.js';
import { repairDefiLlamaSettlementIdentity } from './repair/defillamaSettlement.js';
import { runScheduledTradeRewards, startTradeRewardsScheduler } from './tradeRewards/scheduler.js';

async function main() {
  await runMigrations();
  await startApi();
  startCron();
  startTradeRewardsScheduler();
  logger.info('rebate-indexer ready');

  // Initial backfill so freshly-deployed / newly-seeded tracked wallets populate
  // within seconds rather than waiting for the 02:00 UTC nightly tick.
  // Non-blocking; failures are logged and never crash startup.
  //
  // Pricer + scorer run UNCONDITIONALLY (not only when this run inserted): a
  // prior run may have inserted a trade but failed to price it (transient CoW
  // outage) or left the matview stale — gating on `inserted > 0` would mean a
  // restart could never heal that. Both are cheap no-ops when there's nothing
  // pending (pricer scans `value_usd IS NULL`; scorer just refreshes the view).
  void (async () => {
    try {
      // Under the pipeline lock so it can't overlap the nightly cron (which
      // batches on the 1st). If the nightly is already running, just skip.
      const ran = await withPipelineLock(async () => {
        let inserted = 0;
        let priced = { priced: 0, failed: 0 };
        // Migration 0024 can requeue more owners than runFetcher's bounded batch.
        // Drain successive successful batches now; a persistent failure remains
        // fail-closed through defillama_reporting_state instead of serving partial data.
        for (let i = 0; i < 100; i++) {
          const fetched = await runFetcher();
          inserted += fetched.inserted;
          const pass = await runPricer();
          priced = { priced: priced.priced + pass.priced, failed: priced.failed + pass.failed };
          if (await completeDefiLlamaBackfillIfReady()) break;
          // A short batch means every currently eligible owner was attempted. Do
          // not hammer a persistently failing owner or an unpriceable fill 100 times;
          // readiness stays false and the nightly pipeline retries it safely.
          if (fetched.owners < FETCHER_MAX_OWNERS_PER_RUN) break;
          if (i === 99) logger.error('DefiLlama startup backfill hit guard limit');
        }
        // A migration can requeue eth-flow routers. runFetcher intentionally
        // filters every router out before its owner loop, so those queue rows can
        // never delete themselves and the DefiLlama readiness gate stays closed.
        // The nightly pipeline already performs this repair; startup must do the
        // same so a recovery deploy converges immediately instead of waiting for
        // the next 02:00 UTC tick.
        try {
          const routerRepair = await repairRouterTrades();
          if (routerRepair.scanned > 0 || routerRepair.dequeued > 0) {
            logger.info(routerRepair, 'startup router repair complete');
          }
        } catch (err) {
          logger.error({ err }, 'startup router repair failed (pipeline continues)');
        }
        try {
          const reportingRepair = await repairDefiLlamaSettlementIdentity();
          logger.info(reportingRepair, 'startup DefiLlama settlement repair complete');
        } catch (err) {
          logger.error({ err }, 'startup DefiLlama settlement repair failed (reporting remains fail-closed)');
        }
        // Newly reconstructed fills need pricing before readiness can reopen.
        const repairedPrices = await runPricer();
        priced = {
          priced: priced.priced + repairedPrices.priced,
          failed: priced.failed + repairedPrices.failed,
        };
        await completeDefiLlamaBackfillIfReady();
        const scored = await runScorer();
        logger.info({ inserted, priced, scored }, 'initial backfill complete');
      });
      if (!ran) logger.info('initial backfill skipped (nightly pipeline running)');
      // This deliberately runs after the pipeline lock is released. The rewards
      // worker takes that same lock, so it can never select tickets from a
      // partially refreshed trade set. If a nightly refresh won the lock in the
      // meantime, the independent five-minute scheduler retries it.
      await runScheduledTradeRewards('startup');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'initial backfill failed');
    }
  })();
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
