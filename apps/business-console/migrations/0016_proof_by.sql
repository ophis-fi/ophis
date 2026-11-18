-- Free plan (ARCHITECTURE.md): how the link of a wallet was proved, written once with the proof: by the wallet's own key,
-- or by a contract (ERC-1271). A partner's Overview read it by recovering every signature, about 1 ms of CPU each, and a
-- request has 10. NULL on a row written before this migration: partner.ts recovers that one as it did.
ALTER TABLE wallets ADD COLUMN proof_by TEXT CHECK (proof_by IN ('key', 'contract'));
