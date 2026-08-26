-- Executed fee-policy assessments were not persisted before the reporting-fill
-- ledger gained assessed_fee_bps. Before 2026-08-10, Ophis orders could only
-- carry their persisted flat volume policy; the operated-chain price-improvement
-- policy was introduced later. For those immutable legacy settlements, the
-- already verified flat rate is therefore the exact executed reporting rate.
--
-- Keep a deliberately conservative boundary one full UTC day before deployment.
-- NULL volume rates (surplus/price-improvement shapes) and all later settlements
-- remain incomplete until exact-UID enrichment supplies an executed assessment.
UPDATE defillama_fills
SET assessed_fee_bps = volume_fee_bps::numeric
WHERE assessed_fee_bps IS NULL
  AND fee_verified = true
  AND volume_fee_bps IS NOT NULL
  AND settlement_timestamp < TIMESTAMPTZ '2026-08-10 00:00:00+00';

-- A direct upgrade can otherwise retain an old completion timestamp. Force the
-- live readiness audit to prove UID completeness after the assessment backfill.
UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
