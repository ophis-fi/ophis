-- Sovereign integrator OWN-FEE payout batches (per chain, per cycle month).
--
-- An integrator stacks a partnerFee entry to their OWN recipient (next to the Ophis
-- base entry) on Optimism (10) / Unichain (130). The fee is charged into the Settlement
-- buffer and swept to the Ophis Safe; this ledger records the monthly WETH payout of
-- that swept fee BACK to each ALLOWLISTED own-fee recipient (100% of the own fee -- no
-- fee-share, no keep fraction).
--
-- Kept ENTIRELY SEPARATE from rebate_batches AND affiliate_batches so rebate, affiliate
-- and own-fee recipient addresses + amounts are NEVER mixed. Same 2-of-3 Ophis Safe (the
-- CREATE2-deterministic partner-fee Safe 0x858f0F5eE954846D47155F5203c04aF1819eCeF8) on
-- each sovereign chain, but its own proposal + reconciliation.
--
-- UNLIKE rebate/affiliate (Gnosis-only), own-fee pays on the SOVEREIGN chain the volume
-- routed on, so the batch carries chain_id and the uniqueness is (cycle_month, chain_id)
-- -- one batch per chain per cycle. status: computing | proposing | proposed | executed
-- | failed | no_recipients. Column types + the uint256 NUMERIC(78,0) helper mirror
-- affiliate_batches exactly.
CREATE TABLE IF NOT EXISTS own_fee_batches (
  id                 SERIAL PRIMARY KEY,
  cycle_month        DATE NOT NULL,
  chain_id           INTEGER NOT NULL,
  -- Sum of all entries' owed_wei this cycle+chain (the WETH the own-fee MultiSend pays).
  total_owed_wei     NUMERIC(78, 0) NOT NULL,
  -- WETH/USD price (USD per WETH, 4dp) used to convert USD-denominated owed -> wei.
  weth_usd_price     NUMERIC(20, 4),
  status             TEXT NOT NULL,
  safe_proposal_hash BYTEA,
  safe_tx_hash       BYTEA,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One own-fee batch per (cycle month, chain) -- the idempotency key.
  UNIQUE (cycle_month, chain_id)
);

-- One row per own-fee recipient paid in a cycle+chain. recipient is the own_fee_recipient
-- (== the payout address); owed_wei is the WETH owed; paid_wei stays NULL until reconcile
-- confirms on-chain execution. Mirrors affiliate_batch_entries.
CREATE TABLE IF NOT EXISTS own_fee_batch_entries (
  batch_id   INTEGER NOT NULL REFERENCES own_fee_batches (id),
  recipient  BYTEA NOT NULL,
  owed_wei   NUMERIC(78, 0) NOT NULL,
  paid_wei   NUMERIC(78, 0),
  status     TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (batch_id, recipient)
);
CREATE INDEX IF NOT EXISTS own_fee_entries_recipient_idx ON own_fee_batch_entries (recipient);
