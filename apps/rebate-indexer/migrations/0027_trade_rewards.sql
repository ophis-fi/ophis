-- Finite, non-expiring Ophis trade-reward pilot.
-- Ticket assignment and prize inventory are serialized through one campaign row;
-- one wallet and one settled trade can each create at most one ticket.

CREATE TABLE IF NOT EXISTS trade_reward_campaigns (
  campaign_id          TEXT        PRIMARY KEY,
  allocation_commitment BYTEA      NOT NULL CHECK (octet_length(allocation_commitment) = 32),
  next_allocation_index INTEGER     NOT NULL DEFAULT 0 CHECK (next_allocation_index BETWEEN 0 AND 105),
  enabled              BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_reward_tickets (
  wallet               BYTEA        PRIMARY KEY CHECK (octet_length(wallet) = 20),
  ticket_id            INTEGER      NOT NULL UNIQUE CHECK (ticket_id BETWEEN 1 AND 105),
  amount_usdg          NUMERIC(78,0) NOT NULL CHECK (amount_usdg IN (1000000, 10000000)),
  qualifying_trade_uid BYTEA        NOT NULL UNIQUE CHECK (octet_length(qualifying_trade_uid) = 56),
  qualifying_chain_id  INTEGER      NOT NULL,
  qualifying_value_usd NUMERIC(20,4) NOT NULL CHECK (qualifying_value_usd >= 100),
  wallet_age_chain_id  INTEGER      NOT NULL,
  wallet_age_block     BIGINT       NOT NULL CHECK (wallet_age_block >= 0),
  wallet_age_cutoff    TIMESTAMPTZ  NOT NULL,
  assignment_signature BYTEA        NOT NULL CHECK (octet_length(assignment_signature) = 65),
  signer_epoch         NUMERIC(78)  NOT NULL,
  assignment_tx_hash   BYTEA        CHECK (assignment_tx_hash IS NULL OR octet_length(assignment_tx_hash) = 32),
  assignment_status    TEXT         NOT NULL DEFAULT 'pending'
    CHECK (assignment_status IN ('pending', 'submitted', 'confirmed', 'failed')),
  claim_tx_hash        BYTEA        CHECK (claim_tx_hash IS NULL OR octet_length(claim_tx_hash) = 32),
  claim_status         TEXT         NOT NULL DEFAULT 'unclaimed'
    CHECK (claim_status IN ('unclaimed', 'submitted', 'claimed', 'failed')),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- A permanently ineligible trade must not remain at the head of the candidate
-- queue forever. Rejections are per trade (not per wallet): a later swap can
-- still qualify once the wallet has six months of provable history.
CREATE TABLE IF NOT EXISTS trade_reward_rejections (
  qualifying_trade_uid BYTEA       PRIMARY KEY CHECK (octet_length(qualifying_trade_uid) = 56),
  wallet               BYTEA       NOT NULL CHECK (octet_length(wallet) = 20),
  reason               TEXT        NOT NULL CHECK (reason IN ('wallet_too_young')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trade_reward_assignment_queue_idx
  ON trade_reward_tickets (assignment_status, ticket_id);
CREATE INDEX IF NOT EXISTS trade_reward_claim_queue_idx
  ON trade_reward_tickets (claim_status, ticket_id);
