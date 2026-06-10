-- Affiliate / Partner referral program (2026-06-10).
--
-- Kept ENTIRELY SEPARATE from the rebate tables (rebate_batches /
-- rebate_batch_entries) so rebate and affiliate recipient addresses + amounts are
-- NEVER mixed: one wallet can be BOTH a trader earning a rebate AND a referrer
-- earning affiliate payouts. They are tracked in distinct tables here and reported
-- in distinct sections. Same payout Safe (0x858f0F5eE954846D47155F5203c04aF1819eCeF8),
-- separate proposal + reconciliation.

-- Referral codes. PARTNER codes (kind='partner') are operator-seeded (invite-only):
-- the referrer_wallet of an ACTIVE partner code IS the partner whitelist that gates
-- the Partner dashboard. REGULAR codes (kind='regular') are self-served by a
-- connected wallet. Revoke by setting active=FALSE (the indexer then binds no new
-- referees to it; existing bindings are lifetime).
CREATE TABLE IF NOT EXISTS ref_codes (
  code            TEXT PRIMARY KEY,
  referrer_wallet BYTEA NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('regular', 'partner')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ref_codes_referrer_idx ON ref_codes (referrer_wallet);
-- At most one ACTIVE code per (referrer, kind) so a referrer's tier is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS ref_codes_referrer_kind_active_idx
  ON ref_codes (referrer_wallet, kind) WHERE active;

-- Referral bindings. PK on referred_wallet enforces ONE referrer per wallet,
-- first-bind-wins (ON CONFLICT (referred_wallet) DO NOTHING), lifetime — there is
-- NO UPDATE or DELETE of (code, referrer_wallet) for an existing referred_wallet in
-- any app path. net_new records that the referred wallet had zero prior Ophis trades
-- at bind time (the bind endpoint REJECTS non-net-new wallets, so this is always TRUE
-- here; kept as an explicit audit record). Accrual counts only the referred wallet's
-- trades with block_timestamp >= bound_at.
CREATE TABLE IF NOT EXISTS referrals (
  referred_wallet BYTEA PRIMARY KEY,
  code            TEXT NOT NULL REFERENCES ref_codes (code),
  referrer_wallet BYTEA NOT NULL,
  net_new         BOOLEAN NOT NULL,
  bound_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A referrer cannot refer their own wallet.
  CONSTRAINT referrals_no_self CHECK (referred_wallet <> referrer_wallet)
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_wallet);
CREATE INDEX IF NOT EXISTS referrals_code_idx ON referrals (code);

-- Affiliate payout batches — SEPARATE from rebate_batches. Same monthly cadence and
-- Safe, but its own proposal/reconciliation so affiliate $$ never co-mingles with
-- rebate $$. status: computing | proposing | proposed | executed | failed | no_recipients.
CREATE TABLE IF NOT EXISTS affiliate_batches (
  id               SERIAL PRIMARY KEY,
  cycle_month      DATE NOT NULL UNIQUE,
  -- Sum of all entries' owed_wei this cycle (the WETH the affiliate MultiSend pays).
  total_owed_wei   NUMERIC(78, 0) NOT NULL,
  -- WETH/USD price (USD per WETH, 4dp) used to convert USD-denominated owed -> wei.
  weth_usd_price   NUMERIC(20, 4),
  status           TEXT NOT NULL,
  safe_proposal_hash BYTEA,
  safe_tx_hash     BYTEA,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per referrer paid in a cycle. kind + referred_volume_usd make the report
-- auditable; owed_wei is the WETH actually owed (post-cap for regular).
CREATE TABLE IF NOT EXISTS affiliate_batch_entries (
  batch_id            INTEGER NOT NULL REFERENCES affiliate_batches (id),
  referrer_wallet     BYTEA NOT NULL,
  kind                TEXT NOT NULL,
  -- Referred volume that earned this payout (capped at the regular $1M/mo limit).
  referred_volume_usd NUMERIC(20, 4) NOT NULL,
  owed_wei            NUMERIC(78, 0) NOT NULL,
  paid_wei            NUMERIC(78, 0),
  status              TEXT NOT NULL,
  PRIMARY KEY (batch_id, referrer_wallet)
);
