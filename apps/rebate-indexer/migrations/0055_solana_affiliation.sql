-- Keep the original EVM attribution rules while adding native fills to the same reports.
ALTER VIEW affiliate_attributed_trades RENAME TO affiliate_evm_attributions;

-- A historical fill may arrive after a referral was bound. It still disqualifies
-- a binding made after the wallet had started trading.
CREATE VIEW eligible_affiliate_binds AS
SELECT r.* FROM referrals r
WHERE NOT EXISTS (
  SELECT 1 FROM solana_settled_fills f
  WHERE f.wallet = r.referred_wallet AND f.block_timestamp < r.bound_at
);

CREATE VIEW affiliate_attributed_trades AS
SELECT e.*, COALESCE(t.volume_fee_bps, t.undecoded_fee_fallback_bps)::numeric AS gross_bps
FROM affiliate_evm_attributions e JOIN trades t ON t.trade_uid = e.trade_uid
UNION ALL
SELECT r.referrer_wallet, f.wallet, f.order_uid, -1, f.block_timestamp,
       f.value_usd, 'link', f.base_fee_usd * 10000 / NULLIF(f.value_usd, 0)
FROM solana_settled_fills f JOIN eligible_affiliate_binds r ON r.referred_wallet = f.wallet
WHERE f.block_timestamp >= r.bound_at AND f.value_usd > 0 AND f.base_fee_usd > 0;

CREATE OR REPLACE VIEW affiliate_referees AS
SELECT referrer_wallet, wallet, MIN(first_seen) AS first_seen, MIN(bound_at) AS bound_at,
       BOOL_OR(code_tagged) AS code_tagged
FROM (
  SELECT referrer_wallet, referred_wallet AS wallet, bound_at AS first_seen,
         bound_at, false AS code_tagged
  FROM eligible_affiliate_binds WHERE referrer_wallet <> referred_wallet
  UNION ALL
  SELECT referrer_wallet, wallet, block_timestamp, NULL::timestamptz, true
  FROM affiliate_attributed_trades WHERE source = 'code'
) activity
GROUP BY referrer_wallet, wallet;
