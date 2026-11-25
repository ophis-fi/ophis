-- Public reporting and affiliate accounting only. Solana owners must never enter EVM transfer tables.
CREATE TABLE solana_settled_fills (
  tx_signature BYTEA NOT NULL CHECK (length(tx_signature) = 64),
  instruction_index INTEGER NOT NULL CHECK (instruction_index >= 0),
  order_uid BYTEA NOT NULL CHECK (length(order_uid) = 32),
  slot BIGINT NOT NULL CHECK (slot >= 0),
  block_timestamp TIMESTAMPTZ NOT NULL,
  wallet BYTEA NOT NULL CHECK (length(wallet) = 32),
  sell_mint BYTEA NOT NULL CHECK (length(sell_mint) = 32),
  buy_mint BYTEA NOT NULL CHECK (length(buy_mint) = 32),
  sell_atoms NUMERIC(20,0) NOT NULL CHECK (sell_atoms > 0),
  buy_atoms NUMERIC(20,0) NOT NULL CHECK (buy_atoms > 0),
  value_usd NUMERIC CHECK (value_usd >= 0),
  base_fee_atoms NUMERIC(20,0) CHECK (base_fee_atoms >= 0),
  base_fee_usd NUMERIC CHECK (base_fee_usd >= 0),
  PRIMARY KEY (tx_signature, instruction_index, order_uid)
);
CREATE INDEX solana_settled_fills_wallet_time ON solana_settled_fills (wallet, block_timestamp);

CREATE TABLE solana_fill_sync (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  tail JSONB,
  repair JSONB,
  covered_slot BIGINT,
  covered_block_timestamp TIMESTAMPTZ,
  checked_at TIMESTAMPTZ
);
INSERT INTO solana_fill_sync DEFAULT VALUES;
