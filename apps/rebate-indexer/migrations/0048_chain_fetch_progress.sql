-- A failed chain must not invalidate completed work on another chain.
CREATE TABLE wallet_chain_fetches (
  wallet BYTEA NOT NULL REFERENCES tracked_wallets(wallet) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  failed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (wallet, chain_id)
);

-- Only resolved, immutable appData may establish that an order is unrelated.
-- shortcut: clear this cache when supported appCode recognition rules change.
CREATE TABLE non_ophis_orders (
  chain_id INTEGER NOT NULL,
  trade_uid BYTEA NOT NULL CHECK (octet_length(trade_uid) = 56),
  PRIMARY KEY (chain_id, trade_uid)
);
