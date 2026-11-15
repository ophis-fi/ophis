-- 2026-11-15 review: every count deletes the rows of past hours (data.ts countHour). Without this index that DELETE
-- scanned the whole table at each count, so many keys in one hour multiplied the rows read (the Free plan has 5M a day).
CREATE INDEX proof_checks_hour ON proof_checks (hour);
