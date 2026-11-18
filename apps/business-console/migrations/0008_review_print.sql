-- Registration fix G3. What the operator compares, as it was when the Owner pressed "Submit for review": the Owner
-- seats, their passkeys and the named recovery wallet, as one text (REVIEWED in src/server/data.ts). Every write of
-- the organisation compares it again in its own batch, and a difference clears review_at.
ALTER TABLE organisations ADD COLUMN review_print TEXT;
