-- partner-fees round-7 hardening: DURABLE skipped-attribution marker.
--
-- A skipped (ambiguous) feed attribution is dropped partner fees whose row the cursor
-- has already advanced past - no later query can detect the absence. The in-memory
-- per-run guard (cron partnerFeedOk) fails only the NIGHT the skip happened; by the
-- next 1st the flag is true again and accrual proceeds with the obligation permanently
-- missing. Persist the count per feed chain instead: the fetcher increments it on every
-- skip, the accrual completeness gate BLOCKS while any are unresolved, and the operator
-- clears it with the `partner-fee-resolve-skips` CLI after reconciling (re-cursor or
-- manual accounting), leaving an explicit audit trail in the logs.
ALTER TABLE partner_fee_cursor
  ADD COLUMN unresolved_skips INTEGER NOT NULL DEFAULT 0;
