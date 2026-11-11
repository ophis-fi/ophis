-- Independent review of the company sign-in (R2): one company account stands for at most one seat of an organisation.
-- The code checks it in the commit that confirms a link (seats, and open links of other seats); this is the second line.
CREATE UNIQUE INDEX seats_one_company_account ON seats (org_id, idp, idp_tenant, idp_subject) WHERE idp_subject IS NOT NULL AND state <> 'removed';
