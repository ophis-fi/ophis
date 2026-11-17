-- 2026-11-17 (owner): nothing in the console may cost money. R2 bills past its free tier; D1 on the Free plan only
-- refuses. So the ciphertext of a sealed item moves from the R2 bucket into this table, in the EU database, cut in
-- pieces of at most 990,000 bytes, in order of n: the Worker reads a piece as hex(), and D1 keeps 2,000,000 bytes per
-- string (SEAL.maxBytes, 10,493,952 bytes, makes 11 pieces at most).
-- No foreign key: the pieces are written before the row of sealed_items, and taken out again when that row is refused.
CREATE TABLE sealed_chunks (
  item_id TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n BETWEEN 0 AND 10),
  data BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND 990000),
  PRIMARY KEY (item_id, n)
) STRICT;
