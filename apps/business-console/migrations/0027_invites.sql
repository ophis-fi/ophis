-- Owner, 2026-11-17: an invitation code is 12 characters (three groups of four, Crockford base32: no I, L, O or U)
-- and lives 48 hours. Too short to carry its own signature, so the server keeps it: the SHA-256 of its 12 characters
-- and when it expires. A code is used up by the organisation it makes (organisations.invite_hash, 0007, now the same
-- SHA-256). The codes sealed before this (14 days, MAC label apply-invite) are refused from now on. Only adds a table:
-- the Worker already running never reads it.
CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  expires_at INTEGER NOT NULL, -- Unix ms
  created_at INTEGER NOT NULL
) STRICT;
