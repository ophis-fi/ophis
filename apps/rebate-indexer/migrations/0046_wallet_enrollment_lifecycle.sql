-- Registration is a renewable lease, not a change to FIFO admission order.
ALTER TABLE tracked_wallets ADD COLUMN last_registered_at TIMESTAMPTZ;
UPDATE tracked_wallets SET last_registered_at = first_seen;
ALTER TABLE tracked_wallets ALTER COLUMN last_registered_at SET DEFAULT now();
ALTER TABLE tracked_wallets ALTER COLUMN last_registered_at SET NOT NULL;
ALTER TABLE tracked_wallets ADD COLUMN last_prune_check_at TIMESTAMPTZ;

-- Keep evidence for reconciliation; previously pruning recorded only a count.
CREATE TABLE pruned_wallets (
  wallet BYTEA PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL,
  last_registered_at TIMESTAMPTZ NOT NULL,
  pruned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
