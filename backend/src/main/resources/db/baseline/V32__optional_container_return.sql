-- A decision belongs to a specific shipment/container; replacement shipments start with return required.
ALTER TABLE shipping_order_container ADD COLUMN return_required boolean NOT NULL DEFAULT true;
-- An execution triggered by shipping has no return receiving document.
ALTER TABLE service_execution ALTER COLUMN receiving_order_id DROP NOT NULL;
