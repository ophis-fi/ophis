-- Affiliate attribution via order appData (in addition to the wallet-bind
-- referrals path). A trade whose CoW appData carries metadata.ophisReferrer.code
-- is attributed to that referral code's owner at accrual time. Stored as the raw
-- normalized code (lowercase, grammar-validated by the fetcher); nullable, no FK
-- (a code can be created or deactivated after a trade, and accrual joins by
-- string against ACTIVE ref_codes — a stale/typo code simply doesn't match and
-- falls back to the wallet-bind path).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS appdata_ref_code TEXT;

-- Partial index: only appData-tagged trades are touched by the accrual join and
-- the bind-query exclusion. Most trades are untagged (NULL), so a partial index
-- stays small and the untagged scan path is unchanged.
CREATE INDEX IF NOT EXISTS idx_trades_appdata_ref_code
  ON trades (appdata_ref_code) WHERE appdata_ref_code IS NOT NULL;
