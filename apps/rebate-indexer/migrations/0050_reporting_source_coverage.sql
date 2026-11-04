-- Completion time cannot prove the timestamp through which a source was read.
-- Existing rows stay unknown until a successful refresh records real coverage.
ALTER TABLE wallet_chain_fetches ADD COLUMN covered_through TIMESTAMPTZ;
ALTER TABLE chain_source_fetches ADD COLUMN covered_through TIMESTAMPTZ;
