import { sql } from './db/index.js';

/**
 * Mark the settlement-fill backfill complete only after every previously verified
 * owner has been refreshed since the migration and every discovered fill is priced.
 */
export async function completeDefiLlamaBackfillIfReady(): Promise<boolean> {
  const [row] = await sql<{ ready: boolean }[]>`
    WITH readiness AS (
      SELECT NOT EXISTS (
        SELECT 1 FROM defillama_backfill_wallets
      ) AND NOT EXISTS (
        SELECT 1 FROM defillama_fills WHERE fee_verified = true AND value_usd IS NULL
      ) AS ready
    )
    UPDATE defillama_reporting_state s
    SET completed_at = now()
    FROM readiness r
    WHERE s.singleton = true AND s.completed_at IS NULL AND r.ready
    RETURNING true AS ready
  `;
  if (row?.ready) return true;
  const [state] = await sql<{ ready: boolean }[]>`
    SELECT completed_at IS NOT NULL AS ready
    FROM defillama_reporting_state
    WHERE singleton = true
  `;
  return state?.ready === true;
}

/** True only after the deployment backfill has durably completed. */
export async function isDefiLlamaBackfillComplete(): Promise<boolean> {
  const [row] = await sql<{ ready: boolean }[]>`
    SELECT completed_at IS NOT NULL AS ready
    FROM defillama_reporting_state
    WHERE singleton = true
  `;
  return row?.ready === true;
}
