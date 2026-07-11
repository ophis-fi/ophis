-- 0018: exclude testnet volume from the rebate `wallets` matview.
--
-- The fetcher indexes Sepolia (11155111) alongside the production chains, and
-- the matview had no chain filter, so fee-bearing testnet settlements could
-- enter the 30d rebate ranking and dilute the real WETH pool (audit finding,
-- 2026-07-09). /stats, /earnings, and /xp already filter to production chains;
-- this brings the rebate pool source into line. Sepolia is the only indexed
-- testnet, so a targeted exclusion cannot drift when new MAINNETS are added.
--
-- Preserves the 0011 fee-gate semantics verbatim: keep `IS NULL OR` (legit
-- un-backfilled traders) and `> 0` (surplus/PI forge guard). See 0011 header.

DROP MATERIALIZED VIEW IF EXISTS wallets;

CREATE MATERIALIZED VIEW wallets AS
SELECT
  wallet,
  SUM(value_usd)        AS volume_30d_usd,
  COUNT(*)              AS trade_count_30d,
  MAX(block_timestamp)  AS last_trade_at
FROM trades
WHERE block_timestamp > now() - INTERVAL '30 days'
  AND value_usd IS NOT NULL
  AND (volume_fee_bps IS NULL OR volume_fee_bps > 0)  -- exclude only examined-0 (no Ophis fee)
  AND chain_id <> 11155111  -- Sepolia: testnet volume never ranks for rebates
GROUP BY wallet;

CREATE UNIQUE INDEX wallets_pk ON wallets (wallet);
