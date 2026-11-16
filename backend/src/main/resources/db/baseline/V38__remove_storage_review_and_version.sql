-- Do not silently treat unresolved legacy periods as reliable storage data.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM container_storage_period WHERE needs_review) THEN
        RAISE EXCEPTION 'Storage periods require review before removing review fields';
    END IF;
END $$;

ALTER TABLE container_storage_period
    DROP CONSTRAINT storage_receiving_source_check,
    DROP CONSTRAINT storage_shipping_source_check;
DROP INDEX storage_one_open_uq;
ALTER TABLE container_storage_period
    DROP COLUMN needs_review,
    DROP COLUMN review_reason,
    DROP COLUMN version,
    ADD CONSTRAINT storage_receiving_source_check CHECK (
        num_nonnulls(receiving_order_container_id,waybill_container_id)=1),
    ADD CONSTRAINT storage_shipping_source_check CHECK (
        (shipping_at IS NULL AND shipping_order_container_id IS NULL)
        OR (shipping_at IS NOT NULL AND shipping_order_container_id IS NOT NULL));
CREATE UNIQUE INDEX storage_one_open_uq ON container_storage_period(container_id,terminal_area_id)
    WHERE status='OPEN';
