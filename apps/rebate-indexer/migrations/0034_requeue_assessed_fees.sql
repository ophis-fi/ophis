-- Assessment logic before this migration could persist a flat fallback for an
-- unresolved fill or omit the operated-chain backend improvement policy. NULL
-- is the indexer's retry marker, so reset all assessments for authoritative
-- re-correlation during the bounded owner refresh.
UPDATE defillama_fills
SET assessed_fee_bps = NULL;
