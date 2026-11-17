-- Review of milestone 4b (F1). What a completion changed about the recovery wallet, so that a stop puts exactly that
-- back: the wallet rows that held `anchor` just before the completion, as JSON [{id, anchor, at}].
ALTER TABLE recovery_requests ADD COLUMN undo TEXT;
