ALTER TABLE shipping_order_container_qty ADD COLUMN owner_client_id uuid REFERENCES client;
ALTER TABLE shipping_order_railway_carriage_qty ADD COLUMN owner_railway_carriage_id uuid REFERENCES client;
ALTER TABLE shipping_order_railway_carriage ADD COLUMN owner_railway_carriage_id uuid REFERENCES client;
ALTER TABLE receiving_order ADD COLUMN default_railway_carriage_owner_id uuid REFERENCES client;
ALTER TABLE waybill_railway_carriage ADD COLUMN owner_railway_carriage_id uuid REFERENCES client;

-- Older documents contain no evidence of the wagon owner. Never infer an opening
-- stock balance from a wagon directory entry or the owner of the cargo.
CREATE TABLE railway_carriage_owner_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    railway_carriage_id uuid NOT NULL REFERENCES railway_carriage,
    client_owner_id uuid NOT NULL REFERENCES client,
    receiving_order_id uuid REFERENCES receiving_order,
    shipping_order_id uuid REFERENCES shipping_order,
    status text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT billing_now(),
    CHECK ((receiving_order_id IS NOT NULL AND shipping_order_id IS NULL AND status IN ('EXPECTED','ON_TERMINAL'))
        OR (shipping_order_id IS NOT NULL AND receiving_order_id IS NULL AND status IN ('RESERVED_OUT','DEPARTED'))),
    UNIQUE (railway_carriage_id, receiving_order_id, status),
    UNIQUE (railway_carriage_id, shipping_order_id, status)
);
CREATE INDEX carriage_owner_history_latest ON railway_carriage_owner_history(railway_carriage_id, id DESC);
CREATE VIEW railway_carriage_owner AS
SELECT DISTINCT ON (h.railway_carriage_id) h.*
FROM railway_carriage_owner_history h
LEFT JOIN receiving_order r ON r.id=h.receiving_order_id
LEFT JOIN shipping_order s ON s.id=h.shipping_order_id
WHERE coalesce(r.order_status,s.order_status)<>'CANCELLED'
ORDER BY h.railway_carriage_id,h.id DESC;

COMMENT ON VIEW railway_carriage_owner IS 'Текущий собственник и складской статус вагона по последней операции действующей заявки.';
COMMENT ON TABLE railway_carriage_owner_history IS 'Резерв, приёмка и вывоз вагонов. Отмена заявки сохраняет историю и возвращает предыдущее действующее состояние.';
