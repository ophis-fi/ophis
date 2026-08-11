-- Affiliate liabilities and public fee reporting are separate ledgers.
--
-- Every API-enriched trade has an order-creation policy marker. Normalize only
-- rows created under the 1 bp policy; this preserves genuinely historical flat
-- rates and also repairs values temporarily derived from executedProtocolFees.
UPDATE trades
SET volume_fee_bps = 1
WHERE undecoded_fee_fallback_bps = 1
  AND fee_verified = true
  AND volume_fee_bps > 1;

-- Fractional, reporting-only effective Ophis fee rate. NULL legacy rows safely
-- fall back to volume_fee_bps until the bounded owner refresh revisits the fill.
ALTER TABLE defillama_fills
  ADD COLUMN IF NOT EXISTS assessed_fee_bps NUMERIC(20, 8)
  CHECK (assessed_fee_bps >= 0 AND assessed_fee_bps <= 100);
