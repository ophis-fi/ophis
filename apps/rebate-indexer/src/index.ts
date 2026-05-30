import { runMigrations } from './db/migrate.js';
import { startApi } from './api.js';
import { startCron } from './cron.js';
import { runFetcher } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { logger } from './logger.js';

async function main() {
  await runMigrations();
  await startApi();
  startCron();
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
      const { inserted } = await runFetcher();
      const priced = await runPricer();
      const scored = await runScorer();
      logger.info({ inserted, priced, scored }, 'initial backfill complete');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'initial backfill failed');
    }
  })();
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
