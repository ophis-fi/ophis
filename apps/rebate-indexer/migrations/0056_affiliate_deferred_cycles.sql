-- The general monthly heartbeat tracks the rebate batch. An affiliate cycle
-- waiting for verified Solana fills remains due independently, across months.
CREATE TABLE affiliate_deferred_cycles (
  cycle_month DATE PRIMARY KEY CHECK (EXTRACT(DAY FROM cycle_month) = 1)
);
