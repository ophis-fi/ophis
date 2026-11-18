-- Milestone 4a. The wallets table is made again (it held no row before this milestone; SQLite cannot change a CHECK):
--   state 'pending': a proved wallet that waits for its second person. It is live only while its request is open.
--   snapshot: JSON {owners, threshold, modules} of a Safe, read on both endpoints when the wallet is linked and
--   again when it is approved as the recovery wallet. The colour of the recovery wallet compares the chain with it.
--   A row is never deleted and proof_nonce stays unique: a proof is accepted once, whatever became of its wallet.
--   An address is live once per organisation and chain; unlinked rows are history.
DROP TABLE wallets;
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations (id),
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL CHECK (length(address) = 42 AND address = lower(address)), -- EIP-55 case is display only
  kind TEXT NOT NULL CHECK (kind IN ('safe', 'custodian', 'single_key')),
  label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'unlinked')),
  proof_nonce TEXT NOT NULL UNIQUE,  -- server nonce inside the signed link message; single use
  proof_digest TEXT NOT NULL,        -- the digest rebuilt by the server from its own fields
  proof_signature TEXT NOT NULL,     -- 65-byte ECDSA, or the ERC-1271 bytes ('0x' for an onchain Safe message)
  proof_checked_at INTEGER NOT NULL,
  linked_at INTEGER NOT NULL,
  anchor TEXT CHECK (anchor IN ('current', 'next')), -- recovery wallet; 'next' is in force from anchor_effective_at
  anchor_effective_at INTEGER,
  snapshot TEXT,
  UNIQUE (org_id, id)
) STRICT;
CREATE UNIQUE INDEX wallets_one_anchor ON wallets (org_id, anchor) WHERE anchor IS NOT NULL;
CREATE UNIQUE INDEX wallets_one_live ON wallets (org_id, chain_id, address) WHERE state <> 'unlinked';
