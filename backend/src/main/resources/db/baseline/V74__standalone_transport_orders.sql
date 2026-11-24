-- Keep transport documents, their original numbers and stock movements.
DROP TABLE shipping_order_source_container;
ALTER TABLE receiving_order_container DROP COLUMN source_shipping_order_id;
ALTER TABLE shipping_order
    DROP COLUMN comprehensive_service_order_id,
    DROP COLUMN source_receiving_order_id;
ALTER TABLE receiving_order
    DROP COLUMN comprehensive_service_order_id,
    DROP COLUMN source_shipping_order_id,
    DROP COLUMN service_role,
    DROP COLUMN accepted_container_count,
    DROP COLUMN acceptance_fixed_at;
ALTER TABLE shipping_order_container DROP COLUMN return_required;
DROP TABLE comprehensive_service_order;
DROP SEQUENCE IF EXISTS comprehensive_service_order_number_seq;
