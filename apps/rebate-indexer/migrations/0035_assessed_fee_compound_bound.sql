-- Canonical policies are sequential: the 99 bp improvement cap followed by
-- the 1 bp base can assess 100.0099 bps. Keep the database bound aligned with
-- the indexer's conservative 100.01 bps ceiling.
ALTER TABLE defillama_fills
  DROP CONSTRAINT IF EXISTS defillama_fills_assessed_fee_bps_check;

ALTER TABLE defillama_fills
  ADD CONSTRAINT defillama_fills_assessed_fee_bps_check
  CHECK (assessed_fee_bps >= 0 AND assessed_fee_bps <= 100.01);

-- Reopen the fail-closed reporting backfill before clearing assessments. The
-- startup pipeline must drain every historically verified owner before public
-- DefiLlama totals become available again.
UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;

INSERT INTO defillama_backfill_wallets (wallet)
SELECT DISTINCT wallet
FROM trades
WHERE fee_verified = true
ON CONFLICT (wallet) DO NOTHING;

INSERT INTO tracked_wallets (wallet, first_seen, last_fetched, last_attempt_at)
SELECT q.wallet, now(), NULL, NULL
FROM defillama_backfill_wallets q
LEFT JOIN tracked_wallets t ON t.wallet = q.wallet
WHERE t.wallet IS NULL
ON CONFLICT (wallet) DO NOTHING;

UPDATE tracked_wallets
SET last_fetched = NULL
WHERE wallet IN (SELECT wallet FROM defillama_backfill_wallets);

-- Requeue rows written between the previous reconciliation deployment and this
-- order-class-aware version so no ambiguous assessment remains marked complete.
UPDATE defillama_fills
SET assessed_fee_bps = NULL;
