import { runMigrations } from './db/migrate.js';
import { startApi } from './api.js';
import { startCron } from './cron.js';
import { logger } from './logger.js';

async function main() {
  await runMigrations();
  await startApi();
  startCron();
  logger.info('rebate-indexer ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
