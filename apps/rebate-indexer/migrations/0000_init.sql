-- Tables managed by drizzle would normally come from `drizzle-kit generate`,
-- but we write this migration by hand so we can include the materialized view
-- definition (which drizzle does not model). The table DDL below MUST stay in
-- sync with src/db/schema.ts — tests/integration.test.ts asserts that.

CREATE TABLE trades (
  trade_uid          BYTEA       PRIMARY KEY,
  chain_id           INTEGER     NOT NULL,
  wallet             BYTEA       NOT NULL,
  block_number       BIGINT      NOT NULL,
  block_timestamp    TIMESTAMPTZ NOT NULL,
  sell_token         BYTEA       NOT NULL,
  buy_token          BYTEA       NOT NULL,
  sell_amount        NUMERIC(78) NOT NULL,
  buy_amount         NUMERIC(78) NOT NULL,
  app_code           TEXT        NOT NULL,
  partner_fee_wei    NUMERIC(78),
  value_usd          NUMERIC(20,4),
  priced_at          TIMESTAMPTZ,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_wallet_time_idx ON trades (wallet, block_timestamp DESC);
CREATE INDEX trades_unpriced_idx    ON trades (priced_at) WHERE value_usd IS NULL;

CREATE MATERIALIZED VIEW wallets AS
SELECT
  wallet,
  SUM(value_usd)        AS volume_30d_usd,
  COUNT(*)              AS trade_count_30d,
  MAX(block_timestamp)  AS last_trade_at
FROM trades
WHERE block_timestamp > now() - INTERVAL '30 days'
  AND value_usd IS NOT NULL
GROUP BY wallet
WITH NO DATA;
CREATE UNIQUE INDEX wallets_pk ON wallets (wallet);

CREATE TABLE rebate_batches (
  id                 SERIAL      PRIMARY KEY,
  cycle_month        DATE        NOT NULL UNIQUE,
  net_fee_weth_wei   NUMERIC(78) NOT NULL,
  pool_weth_wei      NUMERIC(78) NOT NULL,
  safe_proposal_hash BYTEA,
  safe_tx_hash       BYTEA,
  status             TEXT        NOT NULL DEFAULT 'computing',
  proposed_at        TIMESTAMPTZ,
  executed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rebate_batch_entries (
  batch_id           INTEGER     NOT NULL REFERENCES rebate_batches(id),
  wallet             BYTEA       NOT NULL,
  volume_30d_usd     NUMERIC(20,4) NOT NULL,
  tier               TEXT        NOT NULL,
  rebate_pct         NUMERIC(5,4) NOT NULL,
  weth_amount_wei    NUMERIC(78) NOT NULL,
  PRIMARY KEY (batch_id, wallet)
);
CREATE INDEX rebate_entries_wallet_idx ON rebate_batch_entries (wallet);
