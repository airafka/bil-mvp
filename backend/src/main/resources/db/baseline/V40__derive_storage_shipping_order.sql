-- Shipping order is obtained through the exact shipping task row.
-- The receiving order link is intentionally retained.
ALTER TABLE container_storage_period
    DROP CONSTRAINT storage_shipping_container_fk,
    DROP CONSTRAINT container_storage_period_check1;
ALTER TABLE shipping_order_container
    DROP CONSTRAINT shipping_container_storage_source_uq,
    ADD CONSTRAINT shipping_container_storage_source_uq UNIQUE(id,container_id);
ALTER TABLE container_storage_period
    DROP COLUMN shipping_order_id,
    ADD CONSTRAINT storage_shipping_container_fk FOREIGN KEY(shipping_order_container_id,container_id)
        REFERENCES shipping_order_container(id,container_id),
    ADD CONSTRAINT storage_shipping_history_check CHECK (
        (shipping_at IS NULL AND shipping_history_id IS NULL)
        OR (shipping_at IS NOT NULL AND shipping_history_id IS NOT NULL));
