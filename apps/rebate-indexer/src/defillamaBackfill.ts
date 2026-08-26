import { sql } from './db/index.js';
import { PRODUCTION_CHAIN_IDS } from './stats-page.js';
import { DECODER_ETHFLOW_OWNERS } from './fetcher.js';

const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);

async function reportingIsReady(): Promise<boolean> {
  const [row] = await sql<{ ready: boolean }[]>`
    SELECT
      NOT EXISTS (SELECT 1 FROM defillama_backfill_wallets)
      AND NOT EXISTS (
        SELECT 1 FROM defillama_fills
        WHERE chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
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
        WHERE t.chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
          AND t.fee_verified = true
          AND (
            t.defillama_expected_fill_count IS NULL
            OR t.defillama_expected_fill_count <> (
              SELECT COUNT(*)::int FROM defillama_fills f
              WHERE f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
            )
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

/** Live fail-closed readiness. A historical completed_at can never mask new gaps. */
export async function isDefiLlamaBackfillComplete(): Promise<boolean> {
  return reportingIsReady();
}
