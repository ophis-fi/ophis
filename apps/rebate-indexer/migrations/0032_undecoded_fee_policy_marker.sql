-- A trade's settlement timestamp is not a reliable fee-policy version: long-lived
-- orders may be created under one policy and settle under another, and decoder-first
-- rows initially carry settlement time. The owner-scoped API fetcher knows the
-- authoritative order.creationDate, so it stores the corresponding fallback rate.
-- NULL means "not API-enriched yet" and is held from affiliate credit.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS undecoded_fee_fallback_bps INTEGER
  CHECK (undecoded_fee_fallback_bps IN (1, 10));
