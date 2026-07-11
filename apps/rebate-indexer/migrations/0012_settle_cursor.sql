-- Per-chain scan cursor for the on-chain settle() decoder. `last_block` is the
-- highest block whose settlement Trade events have been fully decoded AND upserted.
-- It is advanced only after a window's rows land, so a crash mid-window re-scans
-- that window (safe: the trades PK is idempotent). Seeded per chain on first run
-- from SETTLE_SCAN_START_BLOCK_<chainId>.
CREATE TABLE IF NOT EXISTS settle_scan_cursor (
  chain_id   INTEGER PRIMARY KEY,
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
