-- partner-fees Phase B round-3 hardening: explicit carry FOLD marker.
--
-- WHY: the liability rollup and the next-cycle carry read used "each recipient's LATEST
-- carried/quarantined entry" (DISTINCT ON newest cycle). That is only correct when every
-- older carry was FOLDED into the newer entry - true for accrual-created chains (accrual
-- reads the prior carry into the new owed), but FALSE for proposal-time quarantines and
-- failed-execution carries applied to entries in OLDER batches: with several catch-up
-- 'computed' batches in flight, one recipient can hold independent carried/quarantined
-- entries in MULTIPLE batches that were never folded into each other. Latest-only then
-- silently DROPS every older amount from both the reservation and the next payout.
--
-- FIX: track folding explicitly. When a monthly accrual consumes a carried/quarantined
-- entry into a new batch's owed, it stamps that source entry's folded_into_batch_id (in
-- the SAME transaction that inserts the successor entries). The carry read and the
-- liability rollup then simply SUM every UNFOLDED carried/quarantined entry - no
-- latest-only heuristic, so independent per-batch carries all survive. A re-accrual of a
-- still-'computed' batch clears the marks pointing at it (folded_into_batch_id = NULL)
-- before recomputing, so the released carries are read again.
ALTER TABLE partner_fee_batch_entries
  ADD COLUMN folded_into_batch_id INTEGER REFERENCES partner_fee_batches(id);

-- The liability rollup + carry read scan unfolded carried/quarantined entries.
CREATE INDEX partner_fee_batch_entries_unfolded_idx
  ON partner_fee_batch_entries (recipient)
  WHERE folded_into_batch_id IS NULL AND status IN ('carried', 'quarantined');
