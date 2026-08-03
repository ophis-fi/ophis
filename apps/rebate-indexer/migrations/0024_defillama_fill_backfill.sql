-- Migration 0023 introduced the settlement-fill reporting ledger after existing
-- traders had already been fetched. Requeue only wallets with verified historical
-- Ophis trades so the non-blocking startup pipeline immediately rebuilds that ledger
-- instead of waiting for the normal six-hour owner refresh interval.
UPDATE tracked_wallets
SET last_fetched = NULL
WHERE wallet IN (
  SELECT DISTINCT wallet
  FROM trades
  WHERE fee_verified = true
);
