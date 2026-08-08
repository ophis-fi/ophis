-- Persist the operational-alert throttle so restarts and multiple indexer
-- instances cannot turn a persistent rewards outage into Telegram spam.
ALTER TABLE trade_reward_scheduler_state
  ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ;
