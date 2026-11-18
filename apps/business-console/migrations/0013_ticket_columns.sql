-- 2026-11-13: a new passkey is confirmed by a passkey check only. Nothing reads these two columns any more: `nonce`
-- was the input of the confirmation phrase removed that day, `attempts` its count of wrong tries.
ALTER TABLE enrolment_tickets DROP COLUMN attempts;
ALTER TABLE enrolment_tickets DROP COLUMN nonce;
