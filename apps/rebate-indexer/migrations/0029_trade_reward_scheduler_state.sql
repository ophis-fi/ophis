-- Independent liveness heartbeat for the finite trade-reward scheduler.
-- A singleton row avoids an unbounded run-history table while still exposing
-- attempt/success timestamps to /health and operators.
CREATE TABLE IF NOT EXISTS trade_reward_scheduler_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT
);

INSERT INTO trade_reward_scheduler_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;
