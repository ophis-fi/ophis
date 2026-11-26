-- Older applications have a handwritten signer in a sealed declaration.
ALTER TABLE organisations ADD COLUMN registration_screening TEXT;
ALTER TABLE kyb_records ADD COLUMN name_review TEXT;
