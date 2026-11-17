-- 2026-11-15 review: a bot-check (Turnstile) token serves once. Cloudflare's own single use is eventually consistent,
-- so each accepted token's hash stays here for 10 minutes (a token lives 5) and a second use is refused, across clock
-- hours too. Rows past their time are deleted by the next use; the index keeps that delete to the expired rows.
CREATE TABLE used_tokens (hash TEXT PRIMARY KEY, until INTEGER NOT NULL) STRICT;
CREATE INDEX used_tokens_until ON used_tokens (until);
