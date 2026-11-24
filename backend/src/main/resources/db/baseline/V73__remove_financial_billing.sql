ALTER TABLE comprehensive_service_order
    DROP COLUMN selected_complex_service_id,
    DROP COLUMN tariffs_fixed_at;

DROP TABLE payment_invoice_line, payment_invoice, billing_charge, service_execution,
    comprehensive_service_order_tariff, complex_service_tariff, complex_service_catalog;
DROP SEQUENCE IF EXISTS payment_invoice_code_seq;
