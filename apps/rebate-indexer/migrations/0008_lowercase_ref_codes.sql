-- 0008: canonicalize ref_codes.code (and the referrals.code FK) to lowercase.
--
-- The API now reads AND writes referral codes lowercase (mint = random oph<hex>,
-- /ref/bind, /ref/:code, /admin/ref-codes all .toLowerCase()). A referral code is
-- a case-sensitive TEXT primary key, so any pre-existing MIXED-CASE row would be
-- orphaned by the new lowercase write path: e.g. an operator revoking a displayed
-- uppercase code would upsert a new lowercase row and leave the original active
-- (and, for a partner code, leave the wallet whitelisted, since /partner gates on
-- referrer_wallet+kind, not code). This one-time pass aligns any such rows.
--
-- In practice every code is already lowercase (random hex mints + lowercase admin
-- seeds), so the guard below makes this a no-op. It only does work — and only then
-- drops/re-adds the referrals->ref_codes FK (which has no ON UPDATE CASCADE, so a
-- naive UPDATE would transiently violate it) — if a mixed-case row actually exists.
-- Idempotent: re-running finds nothing to canonicalize.
DO $$
DECLARE fk_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM ref_codes WHERE code <> lower(code))
     OR EXISTS (SELECT 1 FROM referrals WHERE code <> lower(code)) THEN
    -- A case-fold COLLISION (e.g. both 'OPHABC' and 'ophabc' already exist) cannot
    -- be auto-canonicalized: lowercasing both to 'ophabc' would duplicate the code
    -- primary key and abort this migration on a cryptic duplicate-key error. Refuse
    -- up front with a clear message so the operator deduplicates deterministically
    -- (decide which row + its referrals survive). referrals.code is not a primary
    -- key, so only ref_codes can collide on the PK rewrite.
    IF EXISTS (SELECT 1 FROM ref_codes GROUP BY lower(code) HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'migration 0008: ref_codes contains case-fold-colliding codes (multiple rows share a lowercased value); deduplicate them manually before this canonicalization can run';
    END IF;
    SELECT conname INTO fk_name
      FROM pg_constraint
      WHERE conrelid = 'referrals'::regclass
        AND contype = 'f'
        AND confrelid = 'ref_codes'::regclass;
    IF fk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE referrals DROP CONSTRAINT %I', fk_name);
    END IF;
    UPDATE ref_codes SET code = lower(code) WHERE code <> lower(code);
    UPDATE referrals SET code = lower(code) WHERE code <> lower(code);
    IF fk_name IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE referrals ADD CONSTRAINT %I FOREIGN KEY (code) REFERENCES ref_codes (code)',
        fk_name
      );
    END IF;
  END IF;
END $$;
