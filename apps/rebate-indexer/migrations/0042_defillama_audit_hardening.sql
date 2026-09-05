-- Exact-UID completeness checks join in this order. The reporting-fill primary
-- key has block_number and log_index between these columns and cannot support
-- the lookup efficiently as history grows.
CREATE INDEX defillama_fills_chain_uid_idx
  ON defillama_fills (chain_id, trade_uid);

-- Decoder aggregates are now part of the queue, so the old fee_verified-only
-- partial index no longer covers every row the audit orders by.
DROP INDEX trades_defillama_repair_pending_idx;
CREATE INDEX trades_defillama_repair_pending_idx
  ON trades (defillama_repair_checked_at, chain_id);

-- Migration 0040 originally copied the nominal aggregate rate into the executed
-- assessment. Clear only that recognizable legacy value so exact enrichment can
-- replace it. Values already derived from executed amounts are retained.
UPDATE defillama_fills
SET assessed_fee_bps = NULL
WHERE settlement_timestamp < TIMESTAMPTZ '2026-08-10 00:00:00+00'
  AND volume_fee_bps IS NOT NULL
  AND assessed_fee_bps = volume_fee_bps::numeric;

-- Re-audit every reporting UID. This includes decoder-only aggregates, whose
-- rebate-side fee_verified flag intentionally remains false but which already
-- have at least one reporting fill and can therefore hide older partial fills.
UPDATE trades t
SET defillama_expected_fill_count = NULL,
    defillama_repair_checked_at = NULL
WHERE t.chain_id IN (1, 10, 56, 100, 130, 137, 4663, 8453, 9745, 42161, 43114, 57073, 59144)
  AND (
    t.fee_verified = true
    OR EXISTS (
      SELECT 1 FROM defillama_fills f
      WHERE f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
    )
  );

UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
