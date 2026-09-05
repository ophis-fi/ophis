-- On a hosted chain, verified volume_fee_bps=0 is an explicit attribution
-- result: the order's appData contained no settled Ophis fee. Sovereign market
-- orders are excluded because their backend can prepend an operated improvement
-- policy independently of appData. NULL policies also remain fail-closed.
UPDATE defillama_fills
SET assessed_fee_bps = 0
WHERE assessed_fee_bps IS NULL
  AND fee_verified = true
  AND volume_fee_bps = 0
  AND chain_id NOT IN (10, 130, 4663);

UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
