-- Stored monthly settlement reports (2026-06-10). The same text delivered to
-- Telegram each month, kept for records / audit. PK on the settled cycle month so
-- a re-run overwrites rather than duplicates.
CREATE TABLE IF NOT EXISTS settlement_reports (
  cycle_month   TEXT PRIMARY KEY,        -- 'YYYY-MM' of the SETTLED activity period
  report_text   TEXT NOT NULL,
  safe_weth_wei NUMERIC(78, 0) NOT NULL,
  rebate_wei    NUMERIC(78, 0) NOT NULL,
  affiliate_wei NUMERIC(78, 0) NOT NULL,
  retained_wei  NUMERIC(78, 0) NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
