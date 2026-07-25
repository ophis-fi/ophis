-- partner-fees Phase B (Wave 3): the indexer money path that accrues per-partner
-- protocol fees from the restricted feed and pays 80% to each partner monthly in
-- WETH from the Ophis fee Safe (20% retained). Reopens audit finding C3/F6 on the
-- money path -> two-reviewer gate.
--
-- MIGRATION NUMBER: 0019 (the spec draft said 0010, but main is far ahead; the last
-- migration on main is 0018_wallets_production_chains.sql, so 0019 is the next free
-- one). A parallel basket-intents Phase A change adds a `basket_id` passthrough
-- column and takes a DIFFERENT number; migrations are glob-sorted + tracked in the
-- __migrations table (src/db/migrate.ts), so distinct numbers coexist without a
-- journal conflict. Expect a rebase if the other change lands first.
--
-- These tables are DELIBERATELY separate from the rebate / affiliate / own-fee
-- tables so partner recipient addresses + amounts are NEVER mixed with any other
-- payout class. Same monthly cadence + same Ophis Safe rails (decision 18), distinct
-- proposal + reconciliation, distinct feed ingestion.

-- ─── Feed ingestion cursor ───────────────────────────────────────────────────
-- Resumable position of the restricted partner-fee feed poller, PER chain (one feed
-- URL per Ophis-operated chain). The feed's cursor is (block_number, log_index) so
-- paging resumes WITHIN a block and never skips a trade at a page boundary. next_*
-- is the position to resume FROM (inclusive of next_log_index within next_block).
CREATE TABLE partner_fee_cursor (
  chain_id       INTEGER PRIMARY KEY,
  next_block     BIGINT NOT NULL DEFAULT 0,
  next_log_index BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Per-partner accrued fee trades ──────────────────────────────────────────
-- One row per (settled fee-bearing trade, partner recipient). A single trade can
-- carry up to MAX_PARTNER_FEE_ENTRIES (3) distinct partner recipients, hence the
-- composite PK (trade_uid, recipient). Re-ingesting the same feed row is idempotent
-- (ON CONFLICT DO NOTHING): the poller can safely re-read a partially-returned block.
--
-- recipient   = the partner's fee recipient (== the on-chain WETH payout address),
--               validated registered+active at order-creation time by Phase A ingress.
-- volume_bps  = the partner's flat Volume rate from appData metadata.partnerFee.
-- fee_token   = the token the protocol fee was actually collected in (the buy/surplus
--               token for a sell order), read from the feed's protocolFeeTokens.
-- fee_amount  = the ACTUALLY-COLLECTED protocol fee amount (uint256 wei) for THIS
--               recipient, read from the feed's protocolFeeAmounts. This is the money.
-- value_usd   = USD value of the trade volume at pricing time (reporting only).
-- fee_usd     = USD value of the collected fee_amount (priced from fee_token/fee_amount);
--               NULL until the nightly pricer prices it. The payout basis sums this.
-- batch_id    = the payout cycle that ACCOUNTED this trade (NULL = not yet accounted).
--               Set when a monthly batch consumes the trade into a recipient's owed,
--               so a trade's fee is never counted into two cycles (no double-pay).
CREATE TABLE partner_fee_trades (
  trade_uid    BYTEA NOT NULL,
  recipient    BYTEA NOT NULL,
  chain_id     INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  log_index    BIGINT NOT NULL,
  volume_bps   INTEGER NOT NULL,
  fee_token    BYTEA NOT NULL,
  fee_amount   NUMERIC(78,0) NOT NULL,
  value_usd    NUMERIC(20,4),
  fee_usd      NUMERIC(20,4),
  priced_at    TIMESTAMPTZ,
  batch_id     INTEGER,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_uid, recipient)
);

-- Unpriced work queue (the nightly pricer scans fee_usd IS NULL).
CREATE INDEX partner_fee_trades_unpriced_idx ON partner_fee_trades (priced_at) WHERE fee_usd IS NULL;
-- The monthly batcher reads the priced, NOT-yet-accounted trades per recipient.
CREATE INDEX partner_fee_trades_unbatched_idx ON partner_fee_trades (recipient) WHERE batch_id IS NULL;

-- ─── Monthly payout batches ──────────────────────────────────────────────────
-- One batch per cycle_month (mirrors affiliate_batches). status lifecycle:
--   computing -> proposing -> proposed -> executed | failed, plus terminal
--   no_recipients (nothing to pay this cycle). The WETH balance guard + Safe
--   MultiSend proposal live in src/partnerFees/payout.ts.
CREATE TABLE partner_fee_batches (
  id                 SERIAL PRIMARY KEY,
  cycle_month        DATE NOT NULL UNIQUE,
  total_owed_wei     NUMERIC(78,0) NOT NULL,
  weth_usd_price     NUMERIC(20,4),
  status             TEXT NOT NULL,
  safe_proposal_hash BYTEA,
  safe_tx_hash       BYTEA,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Per-recipient batch entries ─────────────────────────────────────────────
-- One row per recipient per cycle. status ∈ {paid, carried, quarantined}:
--   paid       = owedUsd >= MIN_PARTNER_PAYOUT_USD and screening + dry-run passed;
--                owed_wei is included in the Safe MultiSend, carried_usd = 0.
--   carried    = owedUsd < MIN_PARTNER_PAYOUT_USD; NOT paid this cycle, the USD rolls
--                forward via carried_usd into next cycle's owed (owed_wei is the
--                WETH-equivalent SNAPSHOT used only by the liability reservation).
--   quarantined= failed sanctions/list screening OR the payout dry-run reverted; NOT
--                paid, the USD rolls forward via carried_usd so it is never lost and
--                is re-attempted next cycle once cleared.
--
-- owed_usd    = the total owed this cycle = 0.8*Σ(new fee_usd) + carried_usd(prev).
-- owed_wei    = WETH-equivalent of owed_usd at THIS cycle's WETH/USD price. Present on
--               EVERY status (paid: the amount paid; carried/quarantined: the snapshot
--               the outstanding-liability reservation sums, so the rebate/affiliate
--               batchers never need a price fetch to reserve partner-owed WETH).
-- carried_usd = USD carried forward (carried/quarantined only; 0 for paid). The
--               authoritative carry-forward amount, re-priced when finally paid.
-- paid_wei    = set = owed_wei once the batch executes on-chain (money left the Safe).
CREATE TABLE partner_fee_batch_entries (
  batch_id    INTEGER NOT NULL REFERENCES partner_fee_batches(id),
  recipient   BYTEA NOT NULL,
  owed_usd    NUMERIC(20,4) NOT NULL,
  owed_wei    NUMERIC(78,0) NOT NULL DEFAULT 0,
  carried_usd NUMERIC(20,4) NOT NULL DEFAULT 0,
  paid_wei    NUMERIC(78,0),
  status      TEXT NOT NULL,
  PRIMARY KEY (batch_id, recipient)
);

CREATE INDEX partner_fee_batch_entries_recipient_idx ON partner_fee_batch_entries (recipient);

-- Foreign key from a consumed trade to its accounting batch (added after the batches
-- table exists). A trade is stamped with batch_id exactly once, so its fee can never
-- be summed into a second cycle's owed.
ALTER TABLE partner_fee_trades
  ADD CONSTRAINT partner_fee_trades_batch_fk FOREIGN KEY (batch_id) REFERENCES partner_fee_batches(id);
