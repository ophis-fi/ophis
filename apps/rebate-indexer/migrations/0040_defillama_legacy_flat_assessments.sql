-- A nominal appData rate is not an executed assessment: integer token rounding
-- (and the aggregate decoder's defensive rate clamp) can make it inaccurate.
-- Legacy rows therefore remain pending until exact-UID enrichment derives the
-- effective rate from executed fee amounts.

-- A direct upgrade can otherwise retain an old completion timestamp. Force the
-- live readiness audit to prove UID completeness and executed assessments.
UPDATE defillama_reporting_state
SET backfill_started_at = now(), completed_at = NULL
WHERE singleton = true;
