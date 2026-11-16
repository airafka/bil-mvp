-- Storage is independent of service catalogues and monetary accruals.
ALTER TABLE container_owner_history
    ADD COLUMN operation_type varchar(40) NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN occurred_at timestamptz,
    ADD COLUMN time_source varchar(40),
    ADD COLUMN terminal_area_id uuid REFERENCES terminal_area_catalog(id),
    ADD COLUMN storage_period_id uuid,
    ADD COLUMN target_history_id uuid REFERENCES container_owner_history(id),
    ADD COLUMN source_system varchar(40),
    ADD COLUMN source_operation_key varchar(200),
    ADD COLUMN reason text,
    ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
    ADD COLUMN review_reason text;

CREATE TABLE container_storage_period (
    id uuid PRIMARY KEY,
    container_id uuid NOT NULL REFERENCES container(id),
    terminal_area_id uuid NOT NULL REFERENCES terminal_area_catalog(id),
    receiving_order_id uuid NOT NULL REFERENCES receiving_order(id),
    arrival_history_id uuid NOT NULL UNIQUE REFERENCES container_owner_history(id),
    arrival_at timestamptz NOT NULL,
    shipping_order_id uuid REFERENCES shipping_order(id),
    departure_history_id uuid UNIQUE REFERENCES container_owner_history(id),
    departure_at timestamptz,
    receiving_client_id uuid REFERENCES client(id),
    arrival_owner_id uuid REFERENCES client(id),
    cargo_name text,
    is_empty boolean,
    status varchar(20) NOT NULL CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
    needs_review boolean NOT NULL DEFAULT false,
    review_reason text,
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (departure_at IS NULL OR departure_at >= arrival_at),
    CHECK ((departure_at IS NULL AND departure_history_id IS NULL AND shipping_order_id IS NULL)
        OR (departure_at IS NOT NULL AND departure_history_id IS NOT NULL AND shipping_order_id IS NOT NULL)),
    CHECK ((status='CLOSED' AND departure_at IS NOT NULL)
        OR (status IN ('OPEN','CANCELLED') AND departure_at IS NULL))
);
ALTER TABLE container_owner_history ADD CONSTRAINT history_storage_period_fk
    FOREIGN KEY(storage_period_id) REFERENCES container_storage_period(id);
CREATE INDEX history_storage_period_idx ON container_owner_history(storage_period_id,created_at,id);
CREATE UNIQUE INDEX history_source_operation_uq ON container_owner_history(source_system,source_operation_key)
    WHERE source_operation_key IS NOT NULL;
CREATE INDEX storage_period_arrival_idx ON container_storage_period(arrival_at DESC,id);
CREATE INDEX storage_period_container_idx ON container_storage_period(container_id,arrival_at);

-- Earlier MVP timestamps without a zone are UTC. Do not apply a fixed +3 hour shift.
UPDATE container_owner_history h SET
    operation_type=CASE
        WHEN cancellation AND order_type='RECEIVING_ORDER' AND old_status='ON_TERMINAL' THEN 'CANCEL_ARRIVAL'
        WHEN cancellation AND order_type='RECEIVING_ORDER' THEN 'CANCEL_RECEIVING_RESERVATION'
        WHEN cancellation AND order_type='SHIPPING_ORDER' AND old_status='DEPARTED' THEN 'CANCEL_DEPARTURE'
        WHEN cancellation AND order_type='SHIPPING_ORDER' THEN 'CANCEL_SHIPPING_RESERVATION'
        WHEN order_type='SERVICE_ORDER' THEN 'OWNER_CHANGE'
        WHEN order_type='RECEIVING_ORDER' AND new_status='EXPECTED' THEN 'RESERVE_RECEIVING'
        WHEN order_type='RECEIVING_ORDER' AND new_status='ON_TERMINAL' AND old_status IS DISTINCT FROM 'ON_TERMINAL' THEN 'ARRIVAL'
        WHEN order_type='SHIPPING_ORDER' AND new_status='RESERVED_OUT' THEN 'RESERVE_SHIPPING'
        WHEN order_type='SHIPPING_ORDER' AND new_status='DEPARTED' AND old_status IS DISTINCT FROM 'DEPARTED' THEN 'DEPARTURE'
        ELSE 'LEGACY' END,
    occurred_at=h.created_at AT TIME ZONE 'UTC', time_source='HISTORY_CREATED', source_system='LEGACY',
    source_operation_key=h.id::text,
    terminal_area_id=CASE WHEN order_type='RECEIVING_ORDER' THEN
        (SELECT terminal_area_catalog_id FROM receiving_order WHERE id=h.order_id)
        WHEN order_type='SHIPPING_ORDER' THEN
        (SELECT terminal_area_catalog_id FROM shipping_order WHERE id=h.order_id) END;
UPDATE container_owner_history h SET occurred_at=m.event_date_time AT TIME ZONE 'UTC',time_source='MOVEMENT'
FROM container_movement m WHERE m.container_id=h.container_id AND m.order_id=h.order_id
    AND ((h.operation_type='ARRIVAL' AND m.event_code='UNLOAD_FINISH')
      OR (h.operation_type='DEPARTURE' AND m.event_code='LOAD_FINISH'));
UPDATE container_owner_history h SET reason=c.reason FROM order_cancellation c
WHERE c.order_id=h.order_id AND h.cancellation AND c.resource=CASE h.order_type
    WHEN 'RECEIVING_ORDER' THEN 'receiving-orders' ELSE 'shipping-orders' END;

-- Replay the recorded operations, including reversals. Never pair across an ambiguous gap.
DO $$
DECLARE h record; p container_storage_period%ROWTYPE; target container_owner_history%ROWTYPE;
        open_count integer; pid uuid;
BEGIN
 FOR h IN SELECT * FROM container_owner_history ORDER BY created_at,
    CASE operation_type WHEN 'RESERVE_RECEIVING' THEN 0 WHEN 'ARRIVAL' THEN 1
      WHEN 'RESERVE_SHIPPING' THEN 2 WHEN 'DEPARTURE' THEN 3 WHEN 'OWNER_CHANGE' THEN 4 ELSE 5 END,id
 LOOP
    p:=NULL; target:=NULL; pid:=NULL;
    SELECT count(*) INTO open_count FROM container_storage_period
      WHERE container_id=h.container_id AND status='OPEN';
    IF open_count=1 THEN
      SELECT * INTO p FROM container_storage_period WHERE container_id=h.container_id AND status='OPEN';
    END IF;
    IF h.operation_type='ARRIVAL' AND h.terminal_area_id IS NOT NULL THEN
      pid:=gen_random_uuid();
      IF open_count>0 THEN
        UPDATE container_storage_period SET needs_review=true,review_reason='Повторный приём без однозначного вывоза'
          WHERE container_id=h.container_id AND status='OPEN';
      END IF;
      INSERT INTO container_storage_period(id,container_id,terminal_area_id,receiving_order_id,arrival_history_id,
          arrival_at,receiving_client_id,arrival_owner_id,status,needs_review,review_reason)
      SELECT pid,h.container_id,h.terminal_area_id,h.order_id,h.id,h.occurred_at,r.client_id,h.new_client_id,'OPEN',
          open_count>0,CASE WHEN open_count>0 THEN 'Повторный приём без однозначного вывоза' END
      FROM receiving_order r WHERE r.id=h.order_id;
    ELSIF h.operation_type='DEPARTURE' THEN
      IF p.id IS NOT NULL AND NOT p.needs_review AND p.terminal_area_id=h.terminal_area_id AND h.occurred_at>=p.arrival_at THEN
        pid:=p.id;
        UPDATE container_storage_period SET shipping_order_id=h.order_id,departure_history_id=h.id,
          departure_at=h.occurred_at,status='CLOSED',version=version+1 WHERE id=pid;
      ELSE
        UPDATE container_owner_history SET needs_review=true,review_reason='Не найден однозначный период для вывоза' WHERE id=h.id;
        UPDATE container_storage_period SET needs_review=true,review_reason='Неоднозначная связь с вывозом'
          WHERE container_id=h.container_id AND status='OPEN';
      END IF;
    ELSIF h.operation_type LIKE 'CANCEL_%' THEN
      SELECT * INTO target FROM container_owner_history x WHERE x.container_id=h.container_id
        AND x.order_id=h.order_id AND x.order_type=h.order_type AND x.operation_type=CASE h.operation_type
          WHEN 'CANCEL_ARRIVAL' THEN 'ARRIVAL' WHEN 'CANCEL_DEPARTURE' THEN 'DEPARTURE'
          WHEN 'CANCEL_RECEIVING_RESERVATION' THEN 'RESERVE_RECEIVING' ELSE 'RESERVE_SHIPPING' END
        AND x.created_at<=h.created_at ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
      pid:=target.storage_period_id;
      UPDATE container_owner_history SET target_history_id=target.id WHERE id=h.id;
      IF h.operation_type='CANCEL_ARRIVAL' THEN
        UPDATE container_storage_period SET status='CANCELLED',version=version+1 WHERE id=pid AND status='OPEN';
        IF NOT FOUND THEN
          UPDATE container_owner_history SET needs_review=true,review_reason='Не найден открытый период отменяемого приёма' WHERE id=h.id;
        END IF;
      ELSIF h.operation_type='CANCEL_DEPARTURE' THEN
        IF pid IS NOT NULL AND open_count=0 THEN
          UPDATE container_storage_period SET status='OPEN',shipping_order_id=NULL,departure_history_id=NULL,
            departure_at=NULL,version=version+1 WHERE id=pid AND status='CLOSED';
        ELSE
          UPDATE container_owner_history SET needs_review=true,review_reason='Невозможно однозначно отменить вывоз' WHERE id=h.id;
        END IF;
      END IF;
    ELSIF h.operation_type IN ('RESERVE_SHIPPING','OWNER_CHANGE') AND p.id IS NOT NULL THEN
      pid:=p.id;
    END IF;
    UPDATE container_owner_history SET storage_period_id=pid,
      terminal_area_id=coalesce(terminal_area_id,(SELECT terminal_area_id FROM container_storage_period WHERE id=pid))
      WHERE id=h.id;
 END LOOP;
END $$;

-- Reconcile the replay with actual register state instead of labelling unmatched arrivals as stock.
UPDATE container_storage_period p SET needs_review=true,review_reason='Период не согласован с текущими остатками'
WHERE p.status='OPEN' AND NOT EXISTS (SELECT 1 FROM container_owner o WHERE o.container_id=p.container_id
    AND o.status IN ('ON_TERMINAL','RESERVED_OUT') AND o.receiving_order_id=p.receiving_order_id);
UPDATE container_owner_history h SET needs_review=true,review_reason='История операции требует проверки'
WHERE (operation_type='LEGACY' OR operation_type IN ('ARRIVAL','DEPARTURE') AND storage_period_id IS NULL)
    AND NOT needs_review;
CREATE UNIQUE INDEX storage_one_open_uq ON container_storage_period(container_id,terminal_area_id)
    WHERE status='OPEN' AND NOT needs_review;

-- Cargo belongs to this arrival, never to other visits of the same container.
UPDATE container_storage_period p SET cargo_name=q.cargo_name,is_empty=q.is_empty
FROM (SELECT p0.id,string_agg(DISTINCT ec.code,'; ') AS cargo_name,bool_and(rc.empty) AS is_empty
      FROM container_storage_period p0 JOIN receiving_order_container rc
        ON rc.receiving_order_id=p0.receiving_order_id AND rc.container_id=p0.container_id
      LEFT JOIN receiving_order_container_item i ON i.receiving_order_container_id=rc.id
      LEFT JOIN etsng_code ec ON ec.id=i.etsng_code_id GROUP BY p0.id) q WHERE p.id=q.id;
UPDATE container_storage_period p SET cargo_name=q.cargo_name,is_empty=q.is_empty
FROM (SELECT p0.id,string_agg(DISTINCT ec.code,'; ') AS cargo_name,
        bool_and(wc.net_weight=0) AS is_empty
      FROM container_storage_period p0 JOIN receiving_order r ON r.id=p0.receiving_order_id AND r.transport_type='RAILWAY'
      JOIN waybill w ON w.receiving_order_id=r.id JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
      JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id AND wc.container_id=p0.container_id
      LEFT JOIN waybill_product wp ON wp.waybill_id=w.id LEFT JOIN etsng_code ec ON ec.id=wp.etsng_code_id
      GROUP BY p0.id) q WHERE p.id=q.id;
