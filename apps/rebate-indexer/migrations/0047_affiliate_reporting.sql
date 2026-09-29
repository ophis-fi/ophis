-- Reporting only. Mirror accrual's disjoint attribution arms and fee gates;
-- do not change payout policy or create permanent referral binds from tags.
CREATE VIEW affiliate_attributed_trades AS
SELECT r.referrer_wallet, t.wallet, t.trade_uid, t.chain_id, t.block_timestamp,
       t.value_usd, 'link'::text AS source
FROM referrals r JOIN trades t ON t.wallet = r.referred_wallet
WHERE r.referrer_wallet <> t.wallet
  AND t.block_timestamp >= r.bound_at
  AND t.value_usd IS NOT NULL AND t.chain_id <> 11155111
  AND COALESCE(t.volume_fee_bps, t.undecoded_fee_fallback_bps, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM ref_codes rc WHERE rc.code = t.appdata_ref_code
      AND rc.active AND rc.referrer_wallet <> t.wallet
  )
UNION ALL
SELECT rc.referrer_wallet, t.wallet, t.trade_uid, t.chain_id, t.block_timestamp,
       t.value_usd, 'code'::text AS source
FROM trades t JOIN ref_codes rc ON rc.code = t.appdata_ref_code AND rc.active
WHERE rc.referrer_wallet <> t.wallet
  AND t.value_usd IS NOT NULL AND t.chain_id <> 11155111
  AND t.volume_fee_bps > 0;

CREATE VIEW affiliate_referees AS
SELECT referrer_wallet, wallet, MIN(first_seen) AS first_seen, MIN(bound_at) AS bound_at,
       BOOL_OR(code_tagged) AS code_tagged
FROM (
  SELECT referrer_wallet, referred_wallet AS wallet, bound_at AS first_seen,
         bound_at, false AS code_tagged
  FROM referrals WHERE referrer_wallet <> referred_wallet
  UNION ALL
  SELECT referrer_wallet, wallet, block_timestamp, NULL::timestamptz, true
  FROM affiliate_attributed_trades WHERE source = 'code'
) activity
GROUP BY referrer_wallet, wallet;
