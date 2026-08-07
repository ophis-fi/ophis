-- The pilot uses trade-level eligibility, not wallet-age or balance proofs.
-- Keep an auditable, operator-managed denylist for evident self-dealing or abuse.

ALTER TABLE trade_reward_tickets
  DROP COLUMN IF EXISTS wallet_age_chain_id,
  DROP COLUMN IF EXISTS wallet_age_block,
  DROP COLUMN IF EXISTS wallet_age_cutoff;

DROP TABLE IF EXISTS trade_reward_rejections;

CREATE TABLE IF NOT EXISTS trade_reward_wallet_blocks (
  wallet      BYTEA       PRIMARY KEY CHECK (octet_length(wallet) = 20),
  reason      TEXT        NOT NULL CHECK (length(trim(reason)) > 0),
  evidence    TEXT,
  created_by  TEXT        NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
