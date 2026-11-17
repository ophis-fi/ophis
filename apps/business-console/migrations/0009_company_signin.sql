-- Company sign-in (owner decision of 2026-11-11): a company account at Microsoft or Google proves who a new passkey
-- belongs to. Passkeys stay the only way to sign in.
-- organisations: the setting (NULL: not chosen yet, which behaves as 'none') and the pinned tenant: Microsoft's
-- tenant id, or Google's hosted domain. seats: the company account linked to the seat. enrolment_tickets: the path
-- of the link (idp and its tenant, fixed when it is issued from the organisation's setting; NULL: none), the
-- work address the inviter gave, and what the provider confirmed (the subject, and when).
ALTER TABLE organisations ADD COLUMN company_signin TEXT CHECK (company_signin IN ('none', 'microsoft', 'google'));
ALTER TABLE organisations ADD COLUMN company_tenant TEXT;
ALTER TABLE seats ADD COLUMN idp TEXT;
ALTER TABLE seats ADD COLUMN idp_tenant TEXT;
ALTER TABLE seats ADD COLUMN idp_subject TEXT;
ALTER TABLE enrolment_tickets ADD COLUMN email TEXT;
ALTER TABLE enrolment_tickets ADD COLUMN idp TEXT;
ALTER TABLE enrolment_tickets ADD COLUMN idp_tenant TEXT;
ALTER TABLE enrolment_tickets ADD COLUMN idp_subject TEXT;
ALTER TABLE enrolment_tickets ADD COLUMN idp_at INTEGER;
