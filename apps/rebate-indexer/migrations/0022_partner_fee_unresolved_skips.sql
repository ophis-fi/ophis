-- partner-fees round-7 hardening: DURABLE, IDENTITY-KEYED skipped-attribution ledger.
--
-- A skipped (ambiguous) feed attribution is dropped partner fees whose row the cursor
-- has already advanced past - no later query can detect the absence. An in-memory
-- per-run guard fails only the NIGHT the skip happened; by the next 1st it is true
-- again and accrual proceeds with the obligation permanently missing.
--
-- Keyed by the SETTLEMENT IDENTITY (chain, uid, block, log) rather than a per-chain
-- counter, for two reasons the counter design failed review on:
--   (1) idempotency: a crash between the skip write and the page-cursor save (or an
--       intentional cursor rewind) re-fetches the same row and re-skips it - identity
--       + ON CONFLICT DO NOTHING makes that a no-op instead of an inflated count, and
--       a rewind over an ALREADY-RESOLVED skip stays resolved (the operator accounted
--       for that fee once; it must not demand a second reconciliation);
--   (2) granular sign-off: the operator resolves per chain (partner-fee-resolve-skips
--       --chain=<id>) after reconciling THAT feed - clearing one blanket counter would
--       reopen the accrual gate while another chain's dropped fees remain unaccounted.
--
-- The accrual completeness gate blocks while ANY row has resolved_at IS NULL.
CREATE TABLE partner_fee_skips (
  chain_id     INTEGER     NOT NULL,
  trade_uid    BYTEA       NOT NULL,
  block_number BIGINT      NOT NULL,
  log_index    BIGINT      NOT NULL,
  reason       TEXT        NOT NULL,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  PRIMARY KEY (chain_id, trade_uid, block_number, log_index)
);

-- The accrual gate scans unresolved rows.
CREATE INDEX partner_fee_skips_unresolved_idx ON partner_fee_skips (chain_id) WHERE resolved_at IS NULL;
