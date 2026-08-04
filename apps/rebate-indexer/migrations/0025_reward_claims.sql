-- Reward claim ledger.
--
-- Before this table the /rewards page had NO way to collect who claimed what: the
-- claim flow ended at a `mailto:` link, so a claim only existed if the visitor
-- actually opened their mail client and sent the pre-filled message. Partner-
-- fulfilled perks (Octav) need a real list of (address, email) pairs to hand to
-- the partner so they can issue the discount codes.
--
-- One row per (wallet, reward). The PK makes re-claiming idempotent: a repeat
-- claim UPDATES the email (someone correcting a typo) instead of inserting a
-- duplicate the partner would mail twice.
--
-- `email` is collected for ONE purpose: contacting the claimer about this reward,
-- in practice by passing it to the named partner so they can send the code. It is
-- not a marketing list and must not be used for one. The signed proof
-- (`signature` over `Ophis claim reward <id>\nAddress: ...\nIssued: ...`) makes
-- every row attributable to a wallet that provably asked for it.
--
-- `xp_at_claim` snapshots the server-computed XP at claim time. Eligibility is
-- re-checked server-side on every claim (never trusted from the client), and the
-- snapshot is what the partner-facing export reports, so a later volume
-- correction cannot retroactively make an already-issued code look unearned.

CREATE TABLE reward_claims (
  wallet                BYTEA        NOT NULL,
  reward_id             TEXT         NOT NULL,
  email                 TEXT         NOT NULL,
  -- Server-computed XP (floor of lifetime fee-bearing volume USD) at claim time.
  xp_at_claim           BIGINT       NOT NULL,
  -- EIP-191 ownership proof + the timestamp it embeds, kept so a claim can be
  -- re-verified offline (viem recoverMessageAddress) long after the fact.
  signature             TEXT         NOT NULL,
  issued                BIGINT       NOT NULL,
  claimed_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, reward_id)
);

-- The partner-facing export is "all claims for reward X, newest first", and the
-- incremental re-share filters on updated_at, so index both together.
CREATE INDEX reward_claims_reward_updated_idx ON reward_claims (reward_id, updated_at DESC);
