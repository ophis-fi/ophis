-- Milestone 4b. Proof checks per organisation per hour (10): the one write a proof makes before its commit.
-- No foreign key and no audit row: the organisation id is the one named in a MAC-signed intent, and counting reads
-- no other row, so a proof for an id that does not exist is counted like any other. Rows of past hours are deleted
-- by the next count.
CREATE TABLE proof_checks (
  org_id TEXT NOT NULL,
  hour INTEGER NOT NULL,             -- Unix time in whole hours
  n INTEGER NOT NULL,
  PRIMARY KEY (org_id, hour)
) STRICT;
