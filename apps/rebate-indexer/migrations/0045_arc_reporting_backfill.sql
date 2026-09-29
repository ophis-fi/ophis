-- Arc (5042) is newly covered by the existing owner-scoped API fetcher. Requeue
-- known wallets so their older Arc fills are not hidden by the refresh cursor.
-- Keep reporting fail-closed until authoritative fills/fees/prices are rebuilt.
-- No ledger deletion, fee-rate rewrite, payout configuration, or scan-cursor jump.
INSERT INTO defillama_backfill_wallets (wallet)
SELECT wallet FROM tracked_wallets
ON CONFLICT (wallet) DO NOTHING;

UPDATE tracked_wallets SET last_fetched = NULL;

UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
