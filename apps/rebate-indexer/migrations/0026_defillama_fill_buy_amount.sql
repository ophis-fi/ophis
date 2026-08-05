-- Preserve both sides of each settlement fill. This lets reporting value a fill
-- exactly when its buy side is the chain's canonical USD reference, including on
-- new chains that DefiLlama's historical coin-price API does not yet namespace.
ALTER TABLE defillama_fills
  ADD COLUMN buy_token BYTEA,
  ADD COLUMN buy_amount NUMERIC(78);

-- Existing terminal orders have a matching aggregate trade. Only copy it when
-- the UID identifies exactly one fill; multi-fill orders must be re-fetched so
-- aggregate amounts are never assigned to an individual settlement.
WITH single_fill_uids AS (
  SELECT trade_uid
  FROM defillama_fills
  GROUP BY trade_uid
  HAVING COUNT(*) = 1
)
UPDATE defillama_fills f
SET buy_token = t.buy_token,
    buy_amount = t.buy_amount
FROM trades t
JOIN single_fill_uids s ON s.trade_uid = t.trade_uid
WHERE f.trade_uid = t.trade_uid;
