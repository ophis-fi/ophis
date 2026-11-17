-- Owner, 2026-11-17 (the first real application): the form also asks for the registered address of the company, its
-- LEI apart from its registration number, and for each person named their position, phone and Telegram. All nullable:
-- an organisation made before has none, an invited member gives none, and Telegram is optional. Only adds columns:
-- the Worker already running reads and writes as before (OPERATIONS.md, "Updating the console").
ALTER TABLE organisations ADD COLUMN registered_address TEXT;
ALTER TABLE organisations ADD COLUMN lei TEXT;
ALTER TABLE seats ADD COLUMN position TEXT;
ALTER TABLE seats ADD COLUMN phone TEXT;
ALTER TABLE seats ADD COLUMN telegram TEXT;
ALTER TABLE application_people ADD COLUMN position TEXT;
ALTER TABLE application_people ADD COLUMN phone TEXT;
ALTER TABLE application_people ADD COLUMN telegram TEXT;
