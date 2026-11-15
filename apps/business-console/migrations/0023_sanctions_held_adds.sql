-- 2026-11-15 review: how many addresses the held list file has that the loaded list lacks (NULL: nothing held, or not
-- known). The desk stops on a hold only when this is above 0 or not known: a held file that only removes addresses
-- leaves the screen stricter, not looser. Every removal is now held for a person.
ALTER TABLE sanctions_lists ADD COLUMN held_adds INTEGER;
