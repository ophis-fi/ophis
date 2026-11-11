-- Milestone 3. Two passkeys of one seat never carry the same label: a member and their colleagues tell
-- passkeys apart by it (which one to revoke, which one was replaced). A revoked passkey gives its label back.
CREATE UNIQUE INDEX credentials_one_label ON credentials (org_id, seat_id, label) WHERE state <> 'revoked';
