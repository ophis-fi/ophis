-- Reporting evidence only. The payout batchers never read these tables.
CREATE TABLE partner_statement_assessments (
  chain_id integer NOT NULL, block_number bigint NOT NULL, log_index integer NOT NULL, trade_uid bytea NOT NULL,
  recipient bytea NOT NULL, token bytea, atoms numeric(78,0),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number, log_index, trade_uid, recipient)
);

CREATE TABLE partner_statement_receipts (
  recipient bytea NOT NULL, chain_id integer NOT NULL, source text NOT NULL,
  transfer_id text NOT NULL, tx bytea NOT NULL, paid_at timestamptz NOT NULL,
  asset text NOT NULL, atoms numeric(78,0) NOT NULL, usd numeric,
  PRIMARY KEY (recipient, chain_id, source, transfer_id)
);

CREATE TABLE partner_statement_sync (
  recipient bytea NOT NULL, chain_id integer NOT NULL, next_nonce integer NOT NULL, checked_at timestamptz, history_from timestamptz,
  PRIMARY KEY (recipient, chain_id)
);

CREATE TABLE partner_statement_tokens (
  chain_id integer NOT NULL, token bytea NOT NULL, decimals integer NOT NULL, symbol text,
  PRIMARY KEY (chain_id, token)
);
