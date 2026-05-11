import { sql } from './db/index.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'scorer' });

/**
 * Refresh the `wallets` materialized view. CONCURRENTLY allows reads from the
 * API server during refresh — required because the swap-page chip is a public-facing
 * read path. Needs the UNIQUE INDEX on wallets(wallet) created in 0000_init.sql.
 */
export async function runScorer(): Promise<{ wallet_count: number }> {
  const t0 = Date.now();
  await sql.unsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY wallets');
  const rows = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM wallets`;
  const count = rows[0]!.count;
  log.info({ wallet_count: count, ms: Date.now() - t0 }, 'wallets refreshed');
  return { wallet_count: count };
}
