-- Sanctions screening: the address lists the operator loads (src/server/onboarding.ts). Two global tables with no
-- org_id: they hold what a public list says, never anything of a client. An organisation's own screening is a KYB row
-- (kyb_records of 0001: screening_outcome, screening_lists, screening_list_version_hash, screened_at), unchanged here.
CREATE TABLE sanctions_lists (
  list TEXT PRIMARY KEY CHECK (list IN ('eu', 'un', 'ofac')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),  -- of the file the addresses were taken from
  entries INTEGER NOT NULL CHECK (entries > 0),      -- addresses loaded: a load is never empty
  loaded_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sanctioned_addresses (
  list TEXT NOT NULL REFERENCES sanctions_lists (list),
  address TEXT NOT NULL CHECK (length(address) = 42 AND address = lower(address)), -- as wallets.address
  PRIMARY KEY (address, list)
) STRICT;
