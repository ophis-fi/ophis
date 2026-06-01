-- Durable, append-only record of each COMPLETED nightly pipeline run.
--
-- Why a new table: /health needs a signal that the 02:00 UTC cron actually ran,
-- but the only liveness timestamp it had — last_fetch_attempt (MAX
-- tracked_wallets.last_attempt_at) — is overwritten by the startup backfill on
-- EVERY redeploy, so it can never witness the nightly tick (a redeploy at any
-- time clobbers it). This table is written ONLY by runPipelineSteps (the cron
-- path); the startup backfill calls runFetcher/runPricer/runScorer directly and
-- does NOT touch it, so a redeploy can't move the last genuine nightly
-- timestamp. /health exposes MAX(ran_at) as last_pipeline_run_at.
--
-- first_of_month flags the runs that included the monthly Safe batcher step, so
-- "did the batcher tick on the 1st?" is answerable from
-- MAX(ran_at) WHERE first_of_month — again without the admin-gated /status or
-- VM SSH. No seed row: it stays NULL until the first real nightly completes,
-- which is the honest state (no pipeline has run since the table was created).
--
-- ~365 rows/year — trivial; no prune or index needed (MAX over a few hundred
-- rows is instant).
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id             SERIAL PRIMARY KEY,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_of_month BOOLEAN     NOT NULL DEFAULT false
);
