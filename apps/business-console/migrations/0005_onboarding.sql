-- Milestone 5a: application, domain proof, review (src/server/onboarding.ts).
-- An organisation made by an application carries its country and its registration number or LEI, and the time its
-- Owner submitted it for review (NULL: not submitted, or sent back). A KYB row carries the reason of a decision that
-- is not an approval (a code from a fixed list). No document is stored.
ALTER TABLE organisations ADD COLUMN country TEXT;
ALTER TABLE organisations ADD COLUMN registration_number TEXT;
ALTER TABLE organisations ADD COLUMN review_at INTEGER;
ALTER TABLE kyb_records ADD COLUMN reason TEXT;
-- One organisation per company domain among those that are not archived: a refused application frees its domain.
CREATE UNIQUE INDEX organisations_one_domain ON organisations (email_domain) WHERE email_domain IS NOT NULL AND state <> 'archived';
