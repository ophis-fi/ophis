-- #1648: orderOpened looks for the taken expiries of the organisation in the next minute. Without this index the lookup
-- read every order row of the organisation (the primary key, org_id then id, narrows to the organisation only), a cost
-- that grows with its history (CodeRabbit, PR #1652). Not unique: commit() serialises the choice of a free second.
CREATE INDEX orders_by_expiry ON orders (org_id, valid_to);
