-- Milestone 5b: the ciphertext of a sealed item lives in the R2 bucket, under the item's id. The row holds what the
-- server can know without a key. The table of 0001 kept the ciphertext in the row (2 MB at most); it was never written.
DROP TABLE sealed_items;
CREATE TABLE sealed_items (
  id TEXT PRIMARY KEY,               -- 128 random bits; also the key of the object in the bucket
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kyb_pack', 'declaration', 'screening_detail')),
  key_generation TEXT NOT NULL DEFAULT 'g1',
  key_fingerprint TEXT NOT NULL CHECK (length(key_fingerprint) = 64), -- SHA-256 of the recipient the browser sealed to
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 10493952),          -- bytes of ciphertext: 10 MB of clear file and the age overhead
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),                   -- of the ciphertext, computed by the server; the audit row carries the same hash
  uploaded_by_seat_id TEXT,          -- NULL when the operator sealed it (screening detail)
  kyb_record_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, uploaded_by_seat_id) REFERENCES seats (org_id, id),
  FOREIGN KEY (org_id, kyb_record_id) REFERENCES kyb_records (org_id, id)
) STRICT;
-- One declaration per organisation: a new upload takes the place of the old one.
CREATE UNIQUE INDEX sealed_one_declaration ON sealed_items (org_id) WHERE kind = 'declaration';
