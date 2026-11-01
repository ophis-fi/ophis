CREATE TABLE chain_source_fetches (
  source TEXT NOT NULL CHECK (source IN ('ethflow', 'decoder')),
  chain_id INTEGER NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  failed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (source, chain_id)
);
