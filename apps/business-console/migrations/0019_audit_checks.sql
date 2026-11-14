-- The check of each organisation's audit chain, kept between loads of the audit page (2026-11-14): the Free plan gives
-- 10 ms of CPU a request, so a load hashes a bounded number of rows (verifyAudit in data.ts). checked_seq and
-- checked_hash: the last row of the run of rows from row 1 that verified; it only moves forward, by compare-and-set.
-- recheck_seq: where the re-check of older rows goes on. broken_seq: the first row found that does not verify, never
-- cleared by code. A cache of the check, not a record: no audit row, and the one write a GET makes.
CREATE TABLE audit_checks (
  org_id TEXT PRIMARY KEY REFERENCES organisations (id),
  checked_seq INTEGER NOT NULL,
  checked_hash TEXT NOT NULL,
  recheck_seq INTEGER NOT NULL,
  broken_seq INTEGER
) STRICT;
