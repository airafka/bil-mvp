ALTER TABLE shipping_order DROP CONSTRAINT ck_shipping_order_filling_type;
ALTER TABLE shipping_order ADD CONSTRAINT ck_shipping_order_filling_type CHECK (
    filling_type='ALL' OR (transport_type='VEHICLE' AND filling_type='NONE_CONTAINER')
    OR (transport_type='RAILWAY' AND filling_type IN ('RAILWAY_CARRIAGE','CONTAINER','NONE'))
);
CREATE TABLE shipping_order_container_qty (
    id uuid PRIMARY KEY, shipping_order_id uuid NOT NULL REFERENCES shipping_order ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('STANDARD_20','STANDARD_40')),
    empty boolean NOT NULL, quantity integer NOT NULL CHECK (quantity>0)
);
CREATE INDEX shipping_qty_by_order ON shipping_order_container_qty(shipping_order_id);
CREATE TABLE shipping_order_etsng_code (
    id uuid PRIMARY KEY, shipping_order_container_qty_id uuid NOT NULL REFERENCES shipping_order_container_qty ON DELETE CASCADE,
    etsng_code_id uuid NOT NULL REFERENCES etsng_code, weight numeric(16,3) NOT NULL CHECK (weight>0),
    UNIQUE(shipping_order_container_qty_id,etsng_code_id,weight)
);
CREATE TABLE shipping_order_railway_carriage_qty (
    id uuid PRIMARY KEY, shipping_order_id uuid NOT NULL REFERENCES shipping_order ON DELETE CASCADE,
    type_id uuid REFERENCES railway_carriage_type, quantity integer NOT NULL CHECK (quantity>0),
    UNIQUE NULLS NOT DISTINCT(shipping_order_id,type_id)
);
ALTER TABLE shipping_order_railway_carriage ADD COLUMN status text CHECK (status='FINISHED');
ALTER TABLE shipping_order_container ADD COLUMN actual_quantity numeric;
ALTER TABLE receiving_order_container ADD COLUMN actual_quantity numeric;
CREATE TABLE inbound_event_config (
    event_code text PRIMARY KEY,
    action_code text NOT NULL CHECK (action_code IN ('TOS_RECEIVING_RESULT','TOS_SHIPMENT_RESULT'))
);
INSERT INTO inbound_event_config(event_code,action_code) VALUES
    ('UNLOAD_FINISH','TOS_RECEIVING_RESULT'), ('LOAD_FINISH','TOS_SHIPMENT_RESULT');
CREATE TABLE inbound_event (
    id uuid PRIMARY KEY, task_id uuid NOT NULL, order_id uuid NOT NULL, order_number text NOT NULL,
    source text NOT NULL, site text NOT NULL, event_code text NOT NULL, event_name text NOT NULL,
    event_date_time timestamptz NOT NULL, external_id text, action_code text, status text NOT NULL
        CHECK (status IN ('NEW','SKIPPED','DONE','INVALID','FAILED')),
    status_details text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX inbound_event_task ON inbound_event(order_id,task_id,event_code);
COMMENT ON TABLE inbound_event IS 'Журнал доставки и обработки входящих пакетов Datareon. Повторная доставка имеет собственную запись.';
COMMENT ON COLUMN inbound_event.event_date_time IS 'Момент операции из пакета TOS. Для принятого факта это значение передаётся в container_owner_history.occurred_at.';
