-- Intraday public-data refresh cadence.
--
-- WHY A SEPARATE TABLE, NOT A ROW IN pipeline_runs: isNightlyDue() asks
--   SELECT MAX(serviced_boundary) < :boundary FROM pipeline_runs
-- so writing intraday rows there would make MAX(serviced_boundary) advance past
-- 02:00 every hour and the 02:00 pipeline would report "not due" FOREVER --
-- silently disabling the batcher, accruals, reconciliation and the monthly
-- report while every dashboard still looked healthy. The two cadences must not
-- share a completion record.
CREATE TABLE IF NOT EXISTS refresh_runs (
  id                SERIAL PRIMARY KEY,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  serviced_boundary TIMESTAMPTZ NOT NULL
);

-- isRefreshDue reads MAX(serviced_boundary); keep that lookup cheap.
CREATE INDEX IF NOT EXISTS refresh_runs_serviced_boundary_idx
  ON refresh_runs (serviced_boundary DESC);
