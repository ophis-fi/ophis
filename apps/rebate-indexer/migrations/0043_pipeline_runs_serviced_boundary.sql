-- Record WHICH nightly boundary a pipeline run serviced, not just when it finished.
--
-- pipeline_runs.ran_at is stamped at the END of runPipelineSteps. The nightly
-- scheduler (cron.ts) decides "is a run due?" by comparing against the most recent
-- 02:00 UTC boundary, so a run that STARTS before a boundary and FINISHES after it
-- lands a ran_at past the new boundary and silently satisfies TWO of them:
--
--   01:50  poll sees yesterday's boundary unmet, starts a run
--   02:30  run finishes; ran_at = 02:30, which is >= today's 02:00 boundary
--   02:40  next poll computes due=false -- today's run never happens
--
-- Early steps (runFetcher, pricer) had already executed BEFORE the boundary, so the
-- day's data is skipped. Around a month rollover this also lets the monthly section
-- work from a pre-boundary snapshot.
--
-- Storing the boundary the invocation CLAIMED removes the inference entirely.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS serviced_boundary TIMESTAMPTZ;

-- Backfill existing rows with the 02:00 UTC boundary that contained ran_at, so the
-- column is meaningful for history too. (In production this table is empty -- the
-- nightly had never completed once -- so this is a no-op there.)
UPDATE pipeline_runs
   SET serviced_boundary = date_trunc('day', ran_at AT TIME ZONE 'UTC' - interval '2 hours')
                           + interval '2 hours'
 WHERE serviced_boundary IS NULL;
