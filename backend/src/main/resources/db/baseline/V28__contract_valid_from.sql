-- Backfill existing contracts with the date explicitly requested by the user.
-- Future contracts must supply their own date; no historical default is assigned.
ALTER TABLE contract ADD COLUMN valid_from date;
UPDATE contract SET valid_from = DATE '2026-01-01';
