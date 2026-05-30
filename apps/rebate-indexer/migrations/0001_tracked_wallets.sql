-- Owner registry for the fetcher.
--
-- ROOT CAUSE (2026-05-30): the fetcher called CoW `GET /api/v1/trades` WITHOUT
-- an `owner`, which returns HTTP 400 ("Must specify exactly one of owner or
-- orderUid"). CoW's orderbook cannot be enumerated globally, so `trades` stayed
-- empty since 2026-05-11 and the whole rebate pipeline had no data. The fetcher
-- now queries per-owner (`GET /api/v1/trades?owner=...`), iterating the wallets
-- recorded here.
--
-- Wallets are registered when they hit `GET /tier/:wallet` (the swap frontend
-- calls it on wallet connect) and seeded below for known testers.
CREATE TABLE IF NOT EXISTS tracked_wallets (
  wallet        BYTEA       PRIMARY KEY,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched  TIMESTAMPTZ
);

-- Seed custodes.eth (known Ophis tester) so the first fetch backfills the
-- existing Gnosis swap without waiting for a /tier hit.
INSERT INTO tracked_wallets (wallet)
VALUES (decode('0494f503912c101bfd76b88e4f5d8a33de284d1a', 'hex'))
ON CONFLICT (wallet) DO NOTHING;
