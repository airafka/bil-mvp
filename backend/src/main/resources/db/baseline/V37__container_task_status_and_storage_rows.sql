-- Physical facts reference the exact task row. Existing order/history links remain as context.
ALTER TABLE receiving_order_container ADD COLUMN status varchar(20)
    CHECK (status IN ('UPLOADED','FINISHED'));
ALTER TABLE shipping_order_container ADD COLUMN status varchar(20)
    CHECK (status IN ('UPLOADED','FINISHED'));
ALTER TABLE waybill_container ADD COLUMN status varchar(20)
    CHECK (status IN ('UPLOADED','FINISHED'));

UPDATE receiving_order_container c SET status=CASE r.order_status
    WHEN 'CONFIRMED' THEN 'UPLOADED' WHEN 'COMPLETED' THEN 'FINISHED' END
FROM receiving_order r WHERE r.id=c.receiving_order_id AND r.transport_type='VEHICLE';
UPDATE shipping_order_container c SET status=CASE s.order_status
    WHEN 'CONFIRMED' THEN 'UPLOADED' WHEN 'COMPLETED' THEN 'FINISHED' END
FROM shipping_order s WHERE s.id=c.shipping_order_id;
UPDATE waybill_container c SET status=CASE r.order_status
    WHEN 'CONFIRMED' THEN 'UPLOADED' WHEN 'COMPLETED' THEN 'FINISHED' END
FROM waybill_railway_carriage wr JOIN waybill w ON w.id=wr.waybill_id
JOIN receiving_order r ON r.id=w.receiving_order_id AND r.transport_type='RAILWAY'
WHERE c.waybill_railway_carriage_id=wr.id;

-- Composite foreign keys prevent linking another physical KTK or another auto order.
ALTER TABLE receiving_order_container ADD CONSTRAINT receiving_container_storage_source_uq
    UNIQUE(id,container_id,receiving_order_id);
ALTER TABLE shipping_order_container ADD CONSTRAINT shipping_container_storage_source_uq
    UNIQUE(id,container_id,shipping_order_id);
ALTER TABLE waybill_container ADD CONSTRAINT waybill_container_storage_source_uq UNIQUE(id,container_id);
ALTER TABLE container_storage_period
    ADD COLUMN receiving_order_container_id uuid,
    ADD COLUMN shipping_order_container_id uuid,
    ADD COLUMN waybill_container_id uuid,
    ADD CONSTRAINT storage_receiving_container_fk FOREIGN KEY(receiving_order_container_id,container_id,receiving_order_id)
        REFERENCES receiving_order_container(id,container_id,receiving_order_id),
    ADD CONSTRAINT storage_shipping_container_fk FOREIGN KEY(shipping_order_container_id,container_id,shipping_order_id)
        REFERENCES shipping_order_container(id,container_id,shipping_order_id),
    ADD CONSTRAINT storage_waybill_container_fk FOREIGN KEY(waybill_container_id,container_id)
        REFERENCES waybill_container(id,container_id);

WITH candidates AS (
    SELECT p.id period_id,c.id row_id FROM container_storage_period p
    JOIN receiving_order r ON r.id=p.receiving_order_id AND r.transport_type='VEHICLE'
    JOIN receiving_order_container c ON c.receiving_order_id=r.id AND c.container_id=p.container_id
), unique_rows AS (SELECT period_id,(array_agg(row_id))[1] row_id FROM candidates GROUP BY period_id HAVING count(*)=1)
UPDATE container_storage_period p SET receiving_order_container_id=u.row_id FROM unique_rows u WHERE p.id=u.period_id;

-- Cancelled railway receipts release their waybills. Their immutable archive identifies the original bill.
WITH bills AS (
    SELECT p.id period_id,w.id bill_id FROM container_storage_period p
    JOIN receiving_order r ON r.id=p.receiving_order_id AND r.transport_type='RAILWAY'
    JOIN waybill w ON w.receiving_order_id=r.id
    UNION
    SELECT p.id,(b->>'id')::uuid FROM container_storage_period p
    JOIN receiving_order r ON r.id=p.receiving_order_id AND r.transport_type='RAILWAY' AND r.order_status='CANCELLED'
    JOIN order_cancellation a ON a.order_id=r.id AND a.resource='receiving-orders'
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.details->'waybills','[]'::jsonb)) b
), candidates AS (
    SELECT DISTINCT b.period_id,c.id row_id FROM bills b
    JOIN container_storage_period p ON p.id=b.period_id
    JOIN waybill_railway_carriage wr ON wr.waybill_id=b.bill_id
    JOIN waybill_container c ON c.waybill_railway_carriage_id=wr.id AND c.container_id=p.container_id
), unique_rows AS (SELECT period_id,(array_agg(row_id))[1] row_id FROM candidates GROUP BY period_id HAVING count(*)=1)
UPDATE container_storage_period p SET waybill_container_id=u.row_id FROM unique_rows u WHERE p.id=u.period_id;

WITH candidates AS (
    SELECT p.id period_id,c.id row_id FROM container_storage_period p
    JOIN shipping_order_container c ON c.shipping_order_id=p.shipping_order_id AND c.container_id=p.container_id
), unique_rows AS (SELECT period_id,(array_agg(row_id))[1] row_id FROM candidates GROUP BY period_id HAVING count(*)=1)
UPDATE container_storage_period p SET shipping_order_container_id=u.row_id FROM unique_rows u WHERE p.id=u.period_id;

UPDATE container_storage_period SET needs_review=true,
    review_reason=concat_ws('; ',nullif(review_reason,''),'Не найдена однозначная строка КТК документа для периода хранения')
WHERE num_nonnulls(receiving_order_container_id,waybill_container_id)<>1
    OR (shipping_at IS NOT NULL AND shipping_order_container_id IS NULL);

ALTER TABLE container_storage_period
    ADD CONSTRAINT storage_receiving_source_check CHECK (
        num_nonnulls(receiving_order_container_id,waybill_container_id)<=1
        AND (needs_review OR num_nonnulls(receiving_order_container_id,waybill_container_id)=1)),
    ADD CONSTRAINT storage_shipping_source_check CHECK (
        (shipping_at IS NULL AND shipping_order_container_id IS NULL)
        OR (shipping_at IS NOT NULL AND (shipping_order_container_id IS NOT NULL OR needs_review)));
CREATE INDEX storage_receiving_container_idx ON container_storage_period(receiving_order_container_id);
CREATE INDEX storage_shipping_container_idx ON container_storage_period(shipping_order_container_id);
CREATE INDEX storage_waybill_container_idx ON container_storage_period(waybill_container_id);

COMMENT ON COLUMN receiving_order_container.status IS 'Статус задания КТК: NULL — не установлен/отменён, UPLOADED — подтверждено, FINISHED — выполнено.';
COMMENT ON COLUMN shipping_order_container.status IS 'Статус задания КТК: NULL — не установлен/отменён, UPLOADED — подтверждено, FINISHED — выполнено.';
COMMENT ON COLUMN waybill_container.status IS 'Статус задания приёма КТК по ЖД: NULL — не установлен/отменён, UPLOADED — подтверждено, FINISHED — выполнено.';
COMMENT ON COLUMN container_storage_period.receiving_order_container_id IS 'Выполненная строка КТК автопоставки, открывшая период. Альтернатива waybill_container_id.';
COMMENT ON COLUMN container_storage_period.waybill_container_id IS 'Выполненная строка КТК ЖД-накладной, открывшая период. Альтернатива receiving_order_container_id.';
COMMENT ON COLUMN container_storage_period.shipping_order_container_id IS 'Выполненная строка КТК вывоза, закрывшая период. При отмене вывоза очищается.';
