-- Reporting preferences follow an address across chains and relinks; wallet proofs and recovery are independent.
CREATE TABLE partner_reporting_exclusions (
  org_id TEXT NOT NULL REFERENCES organisations (id),
  address TEXT NOT NULL CHECK (length(address) = 42 AND address = lower(address)),
  PRIMARY KEY (org_id, address)
) STRICT;
