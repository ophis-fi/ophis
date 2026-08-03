-- Migration 0023 introduced the settlement-fill reporting ledger after existing
-- traders had already been fetched. Requeue only wallets with verified historical
-- Ophis trades so the non-blocking startup pipeline immediately rebuilds that ledger
-- instead of waiting for the normal six-hour owner refresh interval.
CREATE TABLE defillama_reporting_state (
  singleton            BOOLEAN     PRIMARY KEY DEFAULT true CHECK (singleton),
  backfill_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);

INSERT INTO defillama_reporting_state (singleton) VALUES (true);

CREATE TABLE defillama_backfill_wallets (
  wallet BYTEA PRIMARY KEY
);

INSERT INTO defillama_backfill_wallets (wallet)
SELECT DISTINCT wallet
FROM trades
WHERE fee_verified = true;

UPDATE tracked_wallets
SET last_fetched = NULL
WHERE wallet IN (
  SELECT wallet FROM defillama_backfill_wallets
);
