-- Registration fix G1: applications by invitation. The SHA-256 of the application code that made the organisation,
-- unique: a code makes one organisation, once, whatever became of it (a refused application does not free its code).
ALTER TABLE organisations ADD COLUMN invite_hash TEXT;
CREATE UNIQUE INDEX organisations_one_invite ON organisations (invite_hash) WHERE invite_hash IS NOT NULL;
