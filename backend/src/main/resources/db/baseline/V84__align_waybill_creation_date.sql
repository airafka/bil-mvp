-- The timestamp displayed as the ETRAN document creation date was introduced in V11.
ALTER TABLE waybill RENAME COLUMN created_at TO waybill_created_at;
