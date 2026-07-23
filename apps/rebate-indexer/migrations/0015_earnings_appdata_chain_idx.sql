-- Index for the public GET /earnings/:appCode lookup.
--
-- The endpoint filters by appdata_ref_code and GROUPs BY chain_id (also filtering
-- chain_id = ANY(PRODUCTION_CHAIN_IDS)). Migration 0009 already indexes
-- appdata_ref_code alone; this composite (appdata_ref_code, chain_id) partial index
-- additionally serves the per-chain grouping/filtering so the keyless, unauthenticated
-- surface stays a bounded index lookup instead of a scan an attacker could hammer.
--
-- Partial (WHERE appdata_ref_code IS NOT NULL): the vast majority of trades are
-- untagged (NULL), so the index stays small and the untagged path is unchanged, exactly
-- like 0009. IF NOT EXISTS so a re-applied migration is a no-op; non-concurrent build is
-- fine (the trades table is small and the test harness applies migrations in a txn).
CREATE INDEX IF NOT EXISTS idx_trades_appdata_ref_code_chain
  ON trades (appdata_ref_code, chain_id) WHERE appdata_ref_code IS NOT NULL;
