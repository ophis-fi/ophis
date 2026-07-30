-- Partner-fee recipient registry (partner-fees Phase A).
--
-- Replaces the compile-time PARTNER_FEE_RECIPIENT_ALLOWLIST as the source of
-- record for THIRD-PARTY partner-fee recipients. The Ophis partner-fee Safe
-- stays always-allowed in code (app_data::PARTNER_FEE_RECIPIENT_ALLOWLIST) and
-- is intentionally NOT stored here: this table is the self-serve integrator
-- registry only.
--
-- Registration is self-serve and auto-activated (owner decision 16): a row is
-- inserted with status 'active' and the 50 bps default per-partner cap. This
-- knowingly reopens audit finding C3/F6 in a BOUNDED form (worst case 0.9% =
-- 90 bps under the 100 bps operator clamp); the bounding controls are the
-- per-partner max_volume_bps cap (1..=90), the suspend switch (status), the
-- autopilot defense-in-depth recipient filter, and the ingress validator.
--
-- Enforcement is INGRESS-ONLY: order validation reads the active snapshot of
-- this table at order-creation time. Read/settlement paths keep parsing stored
-- orders unconditionally, so suspending a recipient never bricks orders that
-- already settled or are mid-flight.

CREATE TYPE PartnerFeeStatus AS ENUM ('active', 'suspended');

CREATE TABLE partner_fee_recipients (
    -- 20-byte recipient address (the fee destination). Primary key: a recipient
    -- registers exactly once and the row is immutable on re-registration.
    recipient bytea PRIMARY KEY,

    -- Human-readable partner label. Unique so it can key dashboards and payout
    -- reports. Format pinned to [a-z0-9_-]{3,64} (mirrored in the Rust handler).
    label text NOT NULL UNIQUE,

    -- Per-partner Volume-policy bps cap. Defaults to the 50 bps self-serve cap;
    -- constrained to 1..=90 so no single partner can exceed the 90 bps program
    -- cap even if a future admin path raises it.
    max_volume_bps integer NOT NULL DEFAULT 50,

    -- 'active' partners are enforced by ingress validation and paid by the
    -- Phase B accrual pipeline; 'suspended' is the instant kill switch (drops
    -- the recipient from the active snapshot without deleting history).
    status PartnerFeeStatus NOT NULL DEFAULT 'active',

    -- Accrual-ready audit columns (Phase B payout accounting reads these; no
    -- payout logic lands in Phase A).
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT partner_fee_recipient_is_address CHECK (octet_length(recipient) = 20),
    CONSTRAINT partner_fee_label_format CHECK (label ~ '^[a-z0-9_-]{3,64}$'),
    CONSTRAINT partner_fee_max_volume_bps_range CHECK (max_volume_bps BETWEEN 1 AND 90)
);

-- The registry-refresh snapshot query selects active recipients; index the
-- status so the 30s refresh stays cheap as the registry grows.
CREATE INDEX partner_fee_recipients_status ON partner_fee_recipients USING BTREE (status);
