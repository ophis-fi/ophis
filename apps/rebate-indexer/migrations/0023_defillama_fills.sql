-- DefiLlama reporting is settlement-fill based, deliberately separate from the
-- rebate table (which stores one lifetime aggregate row per order). A partially
-- fillable order can settle in several blocks/days, so its fills must retain their
-- own settlement identity and timestamp for correct daily attribution.
CREATE TABLE defillama_fills (
  chain_id            INTEGER     NOT NULL,
  block_number        BIGINT      NOT NULL,
  log_index            INTEGER     NOT NULL,
  trade_uid            BYTEA       NOT NULL,
  settlement_timestamp TIMESTAMPTZ NOT NULL,
  sell_token           BYTEA       NOT NULL,
  sell_amount          NUMERIC(78) NOT NULL,
  volume_fee_bps       INTEGER,
  fee_verified         BOOLEAN     NOT NULL,
  value_usd            NUMERIC(20,4),
  priced_at            TIMESTAMPTZ,
  fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number, log_index, trade_uid)
);

CREATE INDEX defillama_fills_unpriced_idx
  ON defillama_fills (chain_id, block_number, log_index)
  WHERE value_usd IS NULL;

CREATE INDEX defillama_fills_daily_idx
  ON defillama_fills (settlement_timestamp, chain_id)
  WHERE value_usd IS NOT NULL AND fee_verified = true;
