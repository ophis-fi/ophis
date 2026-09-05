-- An aggregate trade is one row per order, while DefiLlama reporting is one row
-- per settlement fill. Persist the exact-UID audit result so readiness can prove
-- that a partially fillable order has every settlement, not merely one of them.
ALTER TABLE trades
  ADD COLUMN defillama_expected_fill_count INTEGER,
  ADD COLUMN defillama_repair_checked_at TIMESTAMPTZ;

ALTER TABLE trades
  ADD CONSTRAINT trades_defillama_expected_fill_count_check
    CHECK (defillama_expected_fill_count IS NULL OR defillama_expected_fill_count > 0);

CREATE INDEX trades_defillama_repair_pending_idx
  ON trades (defillama_repair_checked_at, chain_id)
  WHERE fee_verified = true;

-- Migration 0038 could copy an eth-flow router from legacy trades.wallet into
-- the active-user field before startup's router attribution repair ran. Make
-- those rows incomplete now; repairRouterTrades synchronizes both ledgers when
-- it resolves the receiver. An unresolved router must never count as a person.
UPDATE defillama_fills
SET user_address = NULL
WHERE encode(user_address, 'hex') = ANY(ARRAY[
  '764fe4aa1ff493cf39931c7923c8ff5837596504',
  '38c03729153bccf6a281daf41d7c6a14c543f1d7',
  'c1ee77e8a1b85d5eed702a9bb435f434408a4d29',
  'ba3cb449bd2b4adddbc894d8697f5170800eadec',
  'b37add6ac288bd3825a901cba6ec65a89f31b8cc'
]);

-- Every verified production trade must pass the exact-UID audit and every fill
-- must receive its executed assessment before public reporting reopens.
UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
