-- Owner, 2026-11-17: the application asks what the company does, from a short list (wallet, fund, venture capital,
-- bank, app...). The type sets the kind (partner or institution) on the server and is kept for the operator and the
-- declaration. Nullable: organisations made before have none. Only adds a column: the running Worker is unaffected.
ALTER TABLE organisations ADD COLUMN business_type TEXT;
