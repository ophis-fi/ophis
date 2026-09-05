-- Durable publication heartbeat for the public stats and leaderboard surfaces.
--
-- `last_fetch` is quiet when there are no new trades, `last_fetch_attempt` can be
-- advanced by a startup retry, and `pipeline_runs` deliberately records only the
-- 02:00 UTC cron. None of those timestamps says when the materialized leaderboard
-- was actually published. The scorer updates this singleton only after a
-- successful wallets refresh, so API clients and monitors can distinguish live
-- HTTP from fresh public data.
CREATE TABLE public_data_refresh_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  refreshed_at TIMESTAMPTZ
);

INSERT INTO public_data_refresh_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;
