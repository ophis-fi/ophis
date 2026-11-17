-- 2026-11-13 (owner decision): an application names, besides its applicant, up to 4 more people of the company, each with
-- a work email at the proved domain and the role Owner or Admin. Ophis reviews them with the organisation; its approval
-- makes each one a seat, invited and marked `ophis_approved`. The rows stay: what the application asked for.
CREATE TABLE application_people (
  org_id TEXT NOT NULL REFERENCES organisations (id),
  email TEXT NOT NULL,               -- lower case, at the proved domain or a subdomain of it; never the applicant's
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
  PRIMARY KEY (org_id, email)
) STRICT;
-- The mark: Ophis approved this person with the organisation, so the first enrolment of the seat needs the issuer's
-- confirmation and no second person. The activation of the seat clears it, and it never stands on an active seat.
ALTER TABLE seats ADD COLUMN ophis_approved INTEGER NOT NULL DEFAULT 0 CHECK (ophis_approved = 0 OR (ophis_approved = 1 AND state <> 'active'));
