-- 2026-11-13: the company sign-in (Microsoft, Google) was removed (owner decision). Nothing reads what 0009 and 0010
-- added. First the rows it leaves open, while the columns that find them are still here. A link whose path was not the
-- organisation's setting was dead without a write (the filter PATH of data.ts), and a link of the company path loses
-- the check of the company account: each is written dead, with the pending passkey stored on it and the confirmation
-- that waits, and so is a request to change the setting. A plain link of an organisation without the setting stays.
UPDATE credentials SET state = 'revoked' WHERE state = 'pending' AND ticket_id IN (SELECT t.id FROM enrolment_tickets t JOIN organisations o ON o.id = t.org_id
  WHERE t.state IN ('issued', 'stored') AND (t.idp IS NOT NULL OR o.company_signin IN ('microsoft', 'google')));
UPDATE approvals SET state = 'cancelled', decided_at = unixepoch() * 1000 WHERE state = 'pending' AND (action = 'policy.company' OR (action = 'ticket.confirm' AND subject_id IN (
  SELECT t.id FROM enrolment_tickets t JOIN organisations o ON o.id = t.org_id WHERE t.state IN ('issued', 'stored') AND (t.idp IS NOT NULL OR o.company_signin IN ('microsoft', 'google')))));
UPDATE enrolment_tickets SET state = 'dead' WHERE state IN ('issued', 'stored') AND (idp IS NOT NULL OR org_id IN (SELECT id FROM organisations WHERE company_signin IN ('microsoft', 'google')));
-- Then the index: a column named by an index cannot be dropped. The CHECK of `company_signin` is the column's
-- own and goes with it; no other CHECK names a value of the company sign-in. `seats.email` stays (0001).
DROP INDEX seats_one_company_account;
ALTER TABLE organisations DROP COLUMN company_signin;
ALTER TABLE organisations DROP COLUMN company_tenant;
ALTER TABLE seats DROP COLUMN idp;
ALTER TABLE seats DROP COLUMN idp_tenant;
ALTER TABLE seats DROP COLUMN idp_subject;
ALTER TABLE enrolment_tickets DROP COLUMN email;
ALTER TABLE enrolment_tickets DROP COLUMN idp;
ALTER TABLE enrolment_tickets DROP COLUMN idp_tenant;
ALTER TABLE enrolment_tickets DROP COLUMN idp_subject;
ALTER TABLE enrolment_tickets DROP COLUMN idp_at;
