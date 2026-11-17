-- Where each fill's user_address came from: 'owner', 'onchain_user' (the eth-flow payer) or
-- 'receiver' (the eth-flow fallback when the source had no onchainUser). The business report
-- names an eth-flow fill's wallet only when it is the payer. Nullable, no default: instant, no
-- table rewrite. Old rows stay NULL until the nightly backfill (repair/routerTrades.ts) asks CoW.
ALTER TABLE defillama_fills ADD COLUMN user_source TEXT;
