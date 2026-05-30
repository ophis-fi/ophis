-- Distinguish three kinds of "never successfully fetched" (last_fetched IS NULL)
-- tracked wallets so the prune can't drop legitimate ones:
--   - never-attempted overflow (registered behind the per-run cap under /tier spam)
--   - attempted-but-FAILED (a transient CoW outage on one of its chains; must retry, not evict)
--   - freshly reset during replay-from-genesis
--
-- `last_attempt_at` is stamped on EVERY fetch attempt (success or failure), while
-- `last_fetched` is stamped only on a fully-successful attempt. The prune then
-- evicts only wallets we've genuinely had a fair chance to fetch.
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Backfill existing rows so the first post-deploy nightly prune can't evict an
-- old, never-successfully-fetched wallet before it gets its intended retry
-- window. Stamping last_attempt_at = now() grants every pre-existing wallet a
-- fresh 30-day grace from deploy; the real fetcher overwrites it on each attempt.
UPDATE tracked_wallets SET last_attempt_at = now() WHERE last_attempt_at IS NULL;
