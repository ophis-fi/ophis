-- The record of an order (2026-11-14): who gave the last signing link and when, and the fee the orderbook reports for
-- the filled order (executedFee, in atoms of the asset sold; kept only when the orderbook names that asset as its token).
ALTER TABLE orders ADD COLUMN link_by TEXT;
ALTER TABLE orders ADD COLUMN link_at INTEGER;
ALTER TABLE orders ADD COLUMN executed_fee TEXT;
