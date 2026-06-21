-- Fee-gate the trader-volume matview.
--
-- The `wallets` matview drives the trader-rebate pool split (batcher.ts reads
-- volume_30d_usd), and the pool is funded from fees actually collected to the
-- Ophis Safe. A RECOGNIZED order that paid NO Ophis fee therefore must not count
-- toward trader rebates. `volume_fee_bps = 0` is exactly that case: readVolumeFeeBps
-- returns 0 for an absent / wrong-recipient / backend-rejected partnerFee — including
-- the non-attributable 'ophis-fallback' no-fee order and any forged/decoy fee.
--
-- NULL is KEPT on purpose: NULL means either a valid surplus/PI Ophis fee (which the
-- volume-derived indexer can't price; Ophis emitters don't emit it today) OR — and
-- this is the load-bearing case — a legit trade not yet enriched by the self-healing
-- per-trade backfill (volume_fee_bps was only added in 0010, so legacy rows still
-- inside the 30-day window read NULL until their owner is re-fetched). Excluding NULL
-- would under-count those legit traders on payout day. The backfill converges NULL
-- to a real rate over runs; the scorer refreshes this matview every pipeline run.
-- So we exclude ONLY the definite no-fee `0`, never the ambiguous NULL.
--
-- Postgres has no CREATE OR REPLACE for materialized views, so drop + recreate. The
-- DROP cascades the wallets_pk unique index, which we recreate (REFRESH ...
-- CONCURRENTLY in scorer.ts requires it). Recreate POPULATED (no WITH NO DATA): on an
-- UPGRADE the old wallets was already populated, and index.ts starts the API (line 11)
-- BEFORE the async backfill reaches runScorer (line 31), so a WITH-NO-DATA view would
-- make every /tier and /status read ERROR ("materialized view has not been populated")
-- for the WHOLE initial fetch window. Populating in-migration (a one-time SUM over the
-- 30-day trades, inside the migration's transaction) keeps the view readable the instant
-- the API serves. ispopulated is then true, so the first runScorer does a CONCURRENT
-- refresh (wallets_pk is present, required for CONCURRENTLY).
--
-- INVARIANT (keep in sync): "0 = no Ophis fee -> no credit; NULL = unknown -> retail
-- default / kept" is encoded independently at five sites — fetcher.ts ophisReferrer arm
-- (volume_fee_bps > 0), fetcher.ts widget arm (> 0), this matview (IS NULL OR > 0),
-- accrual.ts COALESCE(volume_fee_bps, GROSS_FEE_BPS), and the fetcher.ts backfill guard
-- (NULL AND excluded > 0). Pinned by fetcher.test.ts (Gate A) + the matview three-state
-- integration test (Gate B). Do NOT drop the `IS NULL OR` here (would under-count legit
-- un-backfilled traders) or the `> 0` in the arms (would reopen the surplus/PI forge).

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
GROUP BY wallet;

CREATE UNIQUE INDEX wallets_pk ON wallets (wallet);
