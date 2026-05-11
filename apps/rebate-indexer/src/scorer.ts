import { logger } from './logger.js';

const log = logger.child({ module: 'scorer' });

/**
 * Refresh the `wallets` materialized view. CONCURRENTLY allows reads from the
 * API server during refresh — required because the swap-page chip is a public-facing
 * read path. Needs the UNIQUE INDEX on wallets(wallet) created in 0000_init.sql.
 */
export async function runScorer(): Promise<{ wallet_count: number }> {
  // Import db lazily so this module can be loaded without DATABASE_URL set.
  const { sql } = await import('./db/index.js');
  const t0 = Date.now();
  // CONCURRENTLY requires the view to be populated first. Check if it has been seeded
  // (it is created WITH NO DATA in 0000_init.sql) and do a non-concurrent initial refresh.
  const seeded = await sql<{ is_populated: boolean }[]>`
    SELECT ispopulated AS is_populated FROM pg_matviews WHERE matviewname = 'wallets'
  `;
  const isPopulated = seeded[0]?.is_populated ?? false;
  if (isPopulated) {
    await sql.unsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY wallets');
  } else {
    await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
  }
  const rows = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM wallets`;
  const count = rows[0]!.count;
  log.info({ wallet_count: count, ms: Date.now() - t0 }, 'wallets refreshed');
  return { wallet_count: count };
}
