-- Ophis Business console: identity schema for the whole first step (milestones 1 to 6).
-- Every tenant row carries org_id. Child rows point at their parent through (org_id, id), so a row
-- can never reference another organisation. Times are Unix milliseconds. Ids are 128-bit random hex.
-- A bearer secret is stored as the SHA-256 (hex) of a 256-bit random value, never in clear.
-- Clear by design: everything here except sealed_items.ciphertext (key-custody.md section 2).

CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('partner', 'institution')),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('unverified', 'active', 'frozen', 'archived')),
  email_domain TEXT,                 -- company domain; free mail domains are refused at registration
  domain_challenge TEXT,             -- value expected in the DNS TXT record
  domain_verified_at INTEGER,
  synced_keys_allowed INTEGER NOT NULL DEFAULT 0 CHECK (synced_keys_allowed IN (0, 1)), -- never applies to Owners
  quarantine_until INTEGER,          -- 7 days after a last-Owner recovery
  created_at INTEGER NOT NULL
) STRICT;

-- A seat is one person's membership in one organisation. A person in two organisations has two seats.
CREATE TABLE seats (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations (id),
  display_name TEXT NOT NULL,
  email TEXT,                        -- optional work email; no trust step uses it
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'trader', 'approver', 'compliance', 'viewer')),
  state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'frozen', 'removed')),
  quarantine_until INTEGER,          -- 24 h or 72 h after a re-enrolment
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id)
) STRICT;

CREATE TABLE enrolment_tickets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first_owner', 'invitation', 're_enrolment')),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'trader', 'approver', 'compliance', 'viewer')),
  issuer_seat_id TEXT,               -- NULL only for the first Owner
  token_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,               -- 128-bit, input of the three-word phrase
  state TEXT NOT NULL CHECK (state IN ('issued', 'stored', 'confirmed', 'cancelled', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3), -- wrong phrases; 3 kill the ticket
  expires_at INTEGER NOT NULL,       -- 10 min for key roles, 24 h for Trader and Viewer
  stored_at INTEGER,                 -- credential stored; the token is dead; confirmation window opens
  wait_until INTEGER,                -- 72 h wait when no second key-role person exists
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  CHECK ((kind = 'first_owner') = (issuer_seat_id IS NULL)),
  FOREIGN KEY (org_id, seat_id) REFERENCES seats (org_id, id),
  FOREIGN KEY (org_id, issuer_seat_id) REFERENCES seats (org_id, id)
) STRICT;

-- Passkeys. Public material only. A replaced passkey is suspended, not deleted.
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,               -- WebAuthn credential id, base64url
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  public_key TEXT NOT NULL,          -- COSE key, base64url
  counter INTEGER NOT NULL DEFAULT 0,
  device_bound INTEGER NOT NULL CHECK (device_bound IN (0, 1)), -- 1 = not backup eligible
  transports TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL,               -- the member's own label; the form says "no personal data"
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended', 'revoked')),
  spare INTEGER NOT NULL DEFAULT 0 CHECK (spare IN (0, 1)),
  ticket_id TEXT UNIQUE,             -- one credential per ticket; NULL when added in a session after a passkey check
  stop_right_until INTEGER,          -- a suspended passkey may stop its replacement until then
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, seat_id) REFERENCES seats (org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES enrolment_tickets (org_id, id)
) STRICT;
CREATE INDEX credentials_by_seat ON credentials (org_id, seat_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- public id, shown in the session list
  token_hash TEXT NOT NULL UNIQUE,
  challenge_hash TEXT NOT NULL UNIQUE, -- the sign-in challenge it used: a replayed assertion cannot open a second session
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,       -- absolute limit: 12 h
  last_seen_at INTEGER NOT NULL,     -- idle limit: 15 min
  step_up_at INTEGER NOT NULL,       -- last passkey check; fresh for 5 min
  revoked_at INTEGER,
  user_agent TEXT,
  country TEXT,                      -- request.cf.country; no IP address is stored
  asn INTEGER,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, seat_id) REFERENCES seats (org_id, id),
  FOREIGN KEY (org_id, credential_id) REFERENCES credentials (org_id, id)
) STRICT;
CREATE INDEX sessions_by_seat ON sessions (org_id, seat_id);

-- Two-person changes. The maker is never the checker: enforced here, not only in code.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,              -- fixed list in code: ticket.confirm, wallet.link, anchor.set, seat.role, policy.set, ...
  subject_id TEXT NOT NULL,          -- id of the row the change applies to
  payload TEXT NOT NULL DEFAULT '{}',-- the new value, JSON of clear fields
  payload_hash TEXT NOT NULL,        -- SHA-256 of payload; the checker's passkey challenge covers it
  requester_seat_id TEXT NOT NULL,
  checker_seat_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'applied')),
  not_before INTEGER,                -- 24 h when a setting is lowered, 72 h when no second person exists
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE (org_id, id),
  CHECK (checker_seat_id IS NULL OR checker_seat_id <> requester_seat_id),
  FOREIGN KEY (org_id, requester_seat_id) REFERENCES seats (org_id, id),
  FOREIGN KEY (org_id, checker_seat_id) REFERENCES seats (org_id, id)
) STRICT;

-- Linked wallets. An address is pinned to one chain: the same address elsewhere can have other owners.
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations (id),
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL CHECK (length(address) = 42 AND address = lower(address)), -- EIP-55 case is display only
  kind TEXT NOT NULL CHECK (kind IN ('safe', 'custodian', 'single_key')),
  label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('linked', 'unlinked')),
  proof_nonce TEXT NOT NULL UNIQUE,  -- server nonce inside the signed link message; single use
  proof_digest TEXT NOT NULL,        -- the digest rebuilt by the server from its own fields
  proof_signature TEXT NOT NULL,     -- 65-byte ECDSA, or the ERC-1271 bytes ('0x' for an onchain Safe message)
  proof_checked_at INTEGER NOT NULL, -- contract wallets are checked again at each use
  linked_at INTEGER NOT NULL,        -- authority for a payout change starts 72 h later
  anchor TEXT CHECK (anchor IN ('current', 'next')), -- recovery anchor; 'next' replaces 'current' after 72 h
  anchor_effective_at INTEGER,
  UNIQUE (org_id, id),
  UNIQUE (org_id, chain_id, address)
) STRICT;
-- One recovery anchor in force per organisation, and at most one waiting to replace it.
CREATE UNIQUE INDEX wallets_one_anchor ON wallets (org_id, anchor) WHERE anchor IS NOT NULL;

-- Last-Owner recovery (recovery.md section 4). A row exists only once a valid anchor proof exists.
CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,           -- the anchor that signed
  seat_id TEXT NOT NULL,             -- the new Owner seat, 'invited' until completion
  action TEXT NOT NULL CHECK (action IN ('replace_owners', 'override_owners')),
  credential_hash TEXT NOT NULL,     -- SHA-256(credential id, COSE key): what the wallet signed
  nonce TEXT NOT NULL UNIQUE,        -- accepted once; the row outlives the request so a replay finds it closed
  digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  owners_snapshot TEXT NOT NULL,     -- JSON: Safe owners, threshold, modules; compared again at completion
  state TEXT NOT NULL CHECK (state IN ('waiting', 'cancelled', 'ready', 'completed', 'lapsed')),
  wait_until INTEGER NOT NULL,       -- 72 h
  objected INTEGER NOT NULL DEFAULT 0 CHECK (objected IN (0, 1)), -- one objection adds 72 h, once
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, wallet_id) REFERENCES wallets (org_id, id),
  FOREIGN KEY (org_id, seat_id) REFERENCES seats (org_id, id)
) STRICT;
CREATE UNIQUE INDEX recovery_one_open ON recovery_requests (org_id) WHERE state IN ('waiting', 'ready');

-- KYB result, never the documents. One row per review or re-check; the newest row is the current one.
CREATE TABLE kyb_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations (id),
  legal_name TEXT NOT NULL,
  registration_number TEXT,          -- LEI or register number
  country TEXT NOT NULL CHECK (length(country) = 2),
  tier TEXT NOT NULL CHECK (tier IN ('standard', 'enhanced')),
  source TEXT NOT NULL,              -- for example "registry lookup"
  evidence_ref TEXT,
  evidence_sha256 TEXT,
  signer_cert_sha256 TEXT,           -- qualified signature, when one was offered
  screening_outcome TEXT CHECK (screening_outcome IN ('clear', 'review', 'hit')), -- per organisation only
  screening_lists TEXT,
  screening_list_version_hash TEXT,
  screened_at INTEGER,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
  decided_at INTEGER,
  recheck_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id)
) STRICT;

-- Sealed in the browser (age v1, one recipient). The server never sees the plaintext and holds no key.
CREATE TABLE sealed_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kyb_pack', 'declaration', 'screening_detail')),
  key_generation TEXT NOT NULL DEFAULT 'g1',
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) <= 2000000), -- D1 row limit
  sha256 TEXT NOT NULL,              -- of the ciphertext; the audit row carries the same hash
  uploaded_by_seat_id TEXT,          -- NULL when the operator sealed it (screening detail)
  kyb_record_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, uploaded_by_seat_id) REFERENCES seats (org_id, id),
  FOREIGN KEY (org_id, kyb_record_id) REFERENCES kyb_records (org_id, id)
) STRICT;

-- Ids only: no names, no emails, no free text, no IP address. One hash chain per organisation.
CREATE TABLE audit_log (
  org_id TEXT NOT NULL REFERENCES organisations (id),
  seq INTEGER NOT NULL,              -- 1, 2, 3 ... per organisation; a concurrent writer collides here and fails
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('seat', 'operator', 'anchor', 'system')),
  actor_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,              -- fixed list in code
  subject_id TEXT,
  detail TEXT,                       -- a code from a fixed list or a hash, never typed text
  country TEXT,
  asn INTEGER,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (org_id, seq)
) STRICT;
-- D1 has no roles: these stop a coding mistake, not someone who can run SQL. The chain detects that.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
