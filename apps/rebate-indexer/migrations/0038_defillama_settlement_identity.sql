-- DefiLlama's aggregator dataset needs actual settlement transactions and actual
-- users, not order/fill counts or eth-flow router owners. Keep the columns nullable
-- while the owner/API and on-chain repair paths converge; /defillama fails closed
-- whenever a verified fill is still missing either identity.
ALTER TABLE defillama_fills
  ADD COLUMN transaction_hash BYTEA,
  ADD COLUMN user_address BYTEA;

ALTER TABLE defillama_fills
  ADD CONSTRAINT defillama_fills_transaction_hash_length_check
    CHECK (transaction_hash IS NULL OR octet_length(transaction_hash) = 32),
  ADD CONSTRAINT defillama_fills_user_address_length_check
    CHECK (user_address IS NULL OR octet_length(user_address) = 20);

CREATE INDEX defillama_fills_tx_idx ON defillama_fills (transaction_hash);
CREATE INDEX defillama_fills_user_idx ON defillama_fills (user_address);

-- The rebate ledger already stores the correctly attributed human wallet for all
-- existing terminal orders (including eth-flow receiver repair), so recover that
-- side immediately. Transaction hashes are refreshed from the authoritative trade
-- API or settlement logs by the application.
UPDATE defillama_fills f
SET user_address = t.wallet
FROM trades t
WHERE t.chain_id = f.chain_id
  AND t.trade_uid = f.trade_uid
  AND f.user_address IS NULL;

-- Re-fetch every historical fill so transaction_hash is populated. UID owner bytes
-- make the queue independent of whether the owner is already tracked.
INSERT INTO defillama_backfill_wallets (wallet)
SELECT DISTINCT substring(trade_uid FROM 33 FOR 20)
FROM defillama_fills
WHERE transaction_hash IS NULL
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

UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
