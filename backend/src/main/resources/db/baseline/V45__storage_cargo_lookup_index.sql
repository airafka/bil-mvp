-- The report aggregates cargo by the exact receiving task, never by the whole order.
-- Avoid a scan of all cargo rows for every displayed/exported period.
CREATE INDEX storage_receiving_item_cargo_idx
    ON receiving_order_container_item(receiving_order_container_id,etsng_code_id);
