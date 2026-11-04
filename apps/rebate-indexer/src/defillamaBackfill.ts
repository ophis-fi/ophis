import { sql } from './db/index.js';
import { PRODUCTION_CHAIN_IDS } from './stats-page.js';
import { DECODER_ETHFLOW_OWNERS } from './fetcher.js';
import { ARC_CHAIN_ID } from './affiliate/rates.js';

const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);

async function reportingIsReady(chainId?: number): Promise<boolean> {
  if (chainId !== undefined && !PRODUCTION_CHAIN_IDS.includes(chainId)) return false;
  const chainIds = chainId === undefined ? [...PRODUCTION_CHAIN_IDS] : [chainId];
  const [row] = await sql<{ ready: boolean }[]>`
    WITH fill_counts AS (
      SELECT chain_id, trade_uid, COUNT(*)::int AS fill_count
      FROM defillama_fills
      WHERE chain_id = ANY(${chainIds})
      GROUP BY chain_id, trade_uid
    )
    SELECT
      EXISTS (SELECT 1 FROM defillama_reporting_state
        WHERE singleton = true
          AND (${chainId !== undefined && chainId !== ARC_CHAIN_ID} OR arc_reconciled_through_block IS NOT NULL))
      AND NOT EXISTS (
        SELECT 1 FROM defillama_backfill_wallets q
        WHERE ${chainId === undefined} OR NOT EXISTS (
          SELECT 1 FROM wallet_chain_fetches f
          WHERE f.wallet = q.wallet AND f.chain_id = ${chainId ?? 0}
            AND NOT f.failed AND f.last_success_at IS NOT NULL AND f.covered_through >= (
              SELECT backfill_started_at FROM defillama_reporting_state WHERE singleton = true
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM defillama_fills
        WHERE chain_id = ANY(${chainIds})
          AND (fee_verified = false
            OR assessed_fee_bps IS NULL
            OR value_usd IS NULL
            OR transaction_hash IS NULL
            OR user_address IS NULL
            OR ('0x' || encode(user_address, 'hex')) = ANY(${ROUTER_WALLETS}))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM trades t
        LEFT JOIN fill_counts f
          ON f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
        WHERE t.chain_id = ANY(${chainIds})
          -- Decoder discoveries deliberately leave the aggregate unverified.
          -- Once even one reporting fill exists, that UID still needs an exact
          -- completeness count so a missing older partial fill cannot disappear.
          AND (t.fee_verified = true OR COALESCE(f.fill_count, 0) > 0)
          AND (
            t.defillama_expected_fill_count IS NULL
            OR t.defillama_expected_fill_count <> COALESCE(f.fill_count, 0)
          )
      ) AS ready
  `;
  return row?.ready === true;
}

/**
 * Keep the durable completion timestamp in sync with live readiness. Any later
 * unverified, unpriced, identity-less, or fill-less row reopens reporting.
 */
export async function completeDefiLlamaBackfillIfReady(): Promise<boolean> {
  const ready = await reportingIsReady();
  await sql`
    UPDATE defillama_reporting_state
    SET completed_at = CASE
      WHEN ${ready} THEN COALESCE(completed_at, now())
      ELSE NULL
    END
    WHERE singleton = true
  `;
  return ready;
}

/** Scoped reads never change global completion or dequeue another chain's work. */
export async function isDefiLlamaBackfillComplete(chainId?: number): Promise<boolean> {
  return reportingIsReady(chainId);
}
