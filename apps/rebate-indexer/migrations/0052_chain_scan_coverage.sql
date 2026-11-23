CREATE TABLE chain_scan_coverage (
  chain_id INTEGER PRIMARY KEY,
  covered_through TIMESTAMPTZ NOT NULL
);

-- Archived history can still need verification after a wallet leaves the active fetch queue.
CREATE TABLE retired_chain_backfills (
  chain_id INTEGER NOT NULL,
  wallet BYTEA NOT NULL,
  required_through TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chain_id, wallet)
);
