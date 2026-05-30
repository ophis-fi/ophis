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
  void (async () => {
    try {
      const { inserted } = await runFetcher();
      if (inserted > 0) {
        await runPricer();
        await runScorer();
      }
      logger.info({ inserted }, 'initial backfill complete');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'initial backfill failed');
    }
  })();
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
