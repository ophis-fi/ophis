-- 2026-11-13: the company sign-in (Microsoft, Google) was removed (owner decision). Nothing reads what 0009 and 0010
-- added. The index first: a column named by an index cannot be dropped. The CHECK of `company_signin` is the column's
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
