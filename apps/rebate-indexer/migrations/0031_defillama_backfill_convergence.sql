-- A reporting wallet can predate the tracked-wallet registry or otherwise be
-- absent from it. Since the fetcher selects owners through tracked_wallets, such
-- a queue row is unreachable and keeps the public endpoint fail-closed forever.
INSERT INTO tracked_wallets (wallet, first_seen, last_fetched, last_attempt_at)
SELECT q.wallet, now(), NULL, NULL
FROM defillama_backfill_wallets q
LEFT JOIN tracked_wallets t ON t.wallet = q.wallet
WHERE t.wallet IS NULL
ON CONFLICT (wallet) DO NOTHING;
