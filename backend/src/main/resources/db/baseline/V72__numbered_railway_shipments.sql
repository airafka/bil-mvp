-- The validated constraint stops the migration before removing plans on an installation
-- that still has unnumbered railway shipments.
ALTER TABLE shipping_order DROP CONSTRAINT ck_shipping_order_filling_type;
ALTER TABLE shipping_order ADD CONSTRAINT ck_shipping_order_filling_type
    CHECK (filling_type = 'ALL' OR (transport_type = 'VEHICLE' AND filling_type = 'NONE_CONTAINER'));
DO $$
BEGIN
    IF EXISTS (SELECT FROM shipping_order_railway_carriage_qty)
       OR EXISTS (SELECT FROM shipping_order_etsng_code)
       OR EXISTS (SELECT FROM shipping_order_railway_carriage WHERE status IS NOT NULL)
    THEN
        RAISE EXCEPTION 'Review existing unnumbered rail composition before removing it';
    END IF;
END $$;
DROP TABLE shipping_order_railway_carriage_qty;
DROP TABLE shipping_order_etsng_code;
ALTER TABLE shipping_order_railway_carriage DROP COLUMN status;
ALTER TABLE shipping_order_container_qty ADD CONSTRAINT ck_auto_shipment_plan CHECK (empty AND quantity = 1);
ALTER TABLE shipping_order_container_qty ADD CONSTRAINT uq_auto_shipment_plan UNIQUE (shipping_order_id);
