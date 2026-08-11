-- Migration 0035 reset every assessed fee, but its queue seed came from the
-- terminal-order `trades` ledger. Open partially filled orders exist only in
-- `defillama_fills`, so recover their owners from the canonical CoW order UID:
-- digest (32 bytes) || owner (20 bytes) || validTo (4 bytes).
--
-- Reopen reporting before extending the queue. It remains fail-closed until
-- these newly discovered owners have been refreshed and their assessments are
-- authoritative again.
UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true
  AND EXISTS (
    SELECT 1
    FROM defillama_fills
    WHERE fee_verified = true
      AND assessed_fee_bps IS NULL
      AND octet_length(trade_uid) = 56
  );

INSERT INTO defillama_backfill_wallets (wallet)
SELECT DISTINCT substring(trade_uid FROM 33 FOR 20)
FROM defillama_fills
WHERE fee_verified = true
  AND assessed_fee_bps IS NULL
  AND octet_length(trade_uid) = 56
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
