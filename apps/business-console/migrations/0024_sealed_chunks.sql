-- 2026-11-17 (owner): nothing in the console may cost money. R2 bills past its free tier; D1 on the Free plan only
-- refuses. So the ciphertext of a sealed item moves from the R2 bucket into this table, in the EU database, cut in
-- pieces under D1's 2 MB per row, in order of n (SEAL.maxBytes, 10,493,952 bytes, makes 6 pieces at most).
-- No foreign key: the pieces are written before the row of sealed_items, and taken out again when that row is refused.
CREATE TABLE sealed_chunks (
  item_id TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n BETWEEN 0 AND 5),
  data BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND 1900000),
  PRIMARY KEY (item_id, n)
) STRICT;
