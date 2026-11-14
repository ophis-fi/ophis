-- The real desk (2026-11-14): what happens to an approved order. Its terms are the approval's value (approvals.payload,
-- covered by payload_hash); this row holds what comes after the approval: the one-time link of the signing page (its
-- SHA-256 only), the expiry fixed when that page first reads the order, the order id and signature once it is sent, and
-- the orderbook's state as last read. One row per approved order, keyed by the approval.
CREATE TABLE orders (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,                  -- the approval's id
  approved_at INTEGER NOT NULL,      -- the terms can be signed for 24 hours from here
  link_hash TEXT UNIQUE CHECK (link_hash IS NULL OR length(link_hash) = 64),
  link_purpose TEXT CHECK (link_purpose IN ('sign', 'cancel')),
  valid_to INTEGER,                  -- Unix seconds, in the signed order
  uid TEXT CHECK (uid IS NULL OR length(uid) = 114), -- not unique: the same wallet may be linked to two organisations
  signature TEXT,
  sent_at INTEGER,
  status TEXT CHECK (status IN ('presignaturePending', 'open', 'fulfilled', 'cancelled', 'expired', 'refused')),
  executed_sell TEXT,
  executed_buy TEXT,
  tx_hash TEXT,
  checked_at INTEGER,
  PRIMARY KEY (org_id, id),
  CHECK ((link_hash IS NULL) = (link_purpose IS NULL)),
  FOREIGN KEY (org_id, id) REFERENCES approvals (org_id, id)
) STRICT;
-- The demo kind is gone: a demo order that still waits in a local database is cancelled, and nothing of it is sent.
UPDATE approvals SET state = 'cancelled' WHERE action = 'order.demo' AND state = 'pending';
