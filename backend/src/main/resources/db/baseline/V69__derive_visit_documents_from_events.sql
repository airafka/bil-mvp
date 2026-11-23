-- Document IDs belong to the physical ARRIVAL / DEPARTURE events. Match tasks
-- by that document and the physical container, including partially completed orders.
CREATE VIEW visit_receiving_tasks AS
SELECT r.id AS receiving_order_id, rc.container_id, rc.id AS task_id, rc.status
FROM receiving_order r JOIN receiving_order_container rc ON rc.receiving_order_id=r.id
WHERE r.transport_type='VEHICLE'
UNION ALL
SELECT w.receiving_order_id, wc.container_id, wc.id, wc.status
FROM receiving_order r JOIN waybill w ON w.receiving_order_id=r.id
JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id
WHERE r.transport_type='RAILWAY';

-- Verify the old links before dropping them. A cancelled railway document may
-- have already released its waybill. Its original document is still in ARRIVAL.
DO $$
DECLARE mismatch record;
BEGIN
    SELECT v.id,v.receiving_order_id,a.order_id AS arrival_order,v.container_id,a.container_id AS event_container
    INTO mismatch FROM container_visit v LEFT JOIN container_owner_history_view a ON a.id=v.receiving_container_owner_history_id
    WHERE (a.operation_type,a.order_id,a.container_id) IS DISTINCT FROM ('ARRIVAL',v.receiving_order_id,v.container_id)
    LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V69: receiving event disagrees with visit: %',row_to_json(mismatch); END IF;

    SELECT v.id,v.receiving_order_id,coalesce(v.receiving_order_container_id,v.waybill_container_id) AS stored_task,
           t.task_ids AS resolved_tasks INTO mismatch
    FROM container_visit v JOIN receiving_order r ON r.id=v.receiving_order_id
    CROSS JOIN LATERAL (
        SELECT array_agg(task_id ORDER BY task_id) AS task_ids, count(*) FILTER (WHERE status='FINISHED') AS finished
        FROM visit_receiving_tasks WHERE receiving_order_id=v.receiving_order_id AND container_id=v.container_id
    ) t
    WHERE v.cancellation_container_owner_history_id IS NULL AND
      (t.finished<>1 OR t.task_ids IS DISTINCT FROM ARRAY[CASE WHEN r.transport_type='VEHICLE'
          THEN v.receiving_order_container_id ELSE v.waybill_container_id END]) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V69: ambiguous receiving task: %',row_to_json(mismatch); END IF;

    SELECT v.id,v.shipping_order_container_id,s.id AS resolved_task,d.order_id INTO mismatch
    FROM container_visit v LEFT JOIN container_owner_history_view d ON d.id=v.shipping_container_owner_history_id
    LEFT JOIN shipping_order_container s ON s.shipping_order_id=d.order_id AND s.container_id=v.container_id
    WHERE s.id IS DISTINCT FROM v.shipping_order_container_id OR (v.shipping_container_owner_history_id IS NOT NULL AND
          ((d.operation_type,d.container_id) IS DISTINCT FROM ('DEPARTURE',v.container_id) OR s.status IS DISTINCT FROM 'FINISHED'))
    LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V69: departure or shipping task disagrees with visit: %',row_to_json(mismatch); END IF;
END $$;

-- The unique arrival FK on visits and the unique arrival per order/container
-- together preserve the old UNIQUE(receiving_order_id,container_id).
CREATE UNIQUE INDEX history_one_arrival_per_receiving ON container_owner_history(order_id,container_id)
    WHERE history_operation_type(order_type,old_status,new_status)='ARRIVAL';

DROP VIEW container_visit_facts;
CREATE VIEW container_visit_facts AS
SELECT v.id,v.container_id,v.receiving_container_owner_history_id,v.shipping_container_owner_history_id,
       v.cancellation_container_owner_history_id,a.order_id AS receiving_order_id,d.order_id AS shipping_order_id,
       (a.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS receiving_date,
       (d.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS shipping_date,
       v.cancellation_container_owner_history_id IS NOT NULL AS is_cancelled
FROM container_visit v JOIN container_owner_history a ON a.id=v.receiving_container_owner_history_id
LEFT JOIN container_owner_history d ON d.id=v.shipping_container_owner_history_id;

CREATE OR REPLACE VIEW container_owner_current AS
SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
       v.id AS container_visit_id,o.version,o.receiving_order_id,o.client_id
FROM container_owner o LEFT JOIN container_visit_facts v ON v.container_id=o.container_id
    AND v.receiving_order_id=o.receiving_order_id AND NOT v.is_cancelled AND o.status<>'EXPECTED';

CREATE OR REPLACE VIEW container_storage_period_origin AS
SELECT p.id,v.container_id,v.receiving_order_id,v.receiving_container_owner_history_id AS arrival_history_id
FROM container_period p JOIN container_visit_facts v ON v.id=p.container_visit_id;

CREATE OR REPLACE FUNCTION storage_receiving_order(period_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT o.receiving_order_id FROM container_storage_period_origin o WHERE o.id=period_id
$$;

CREATE FUNCTION check_visit_receiving_task(receiving_id uuid,ktk uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT (SELECT count(*)=1 AND count(*) FILTER (WHERE status='FINISHED')=1
            FROM visit_receiving_tasks WHERE receiving_order_id=receiving_id AND container_id=ktk) THEN
        RAISE EXCEPTION 'Receiving % requires exactly one finished task for container %',receiving_id,ktk USING ERRCODE='23514';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ownership_transfer_candidates(transfer_date date, target_client uuid, own_order uuid)
 RETURNS TABLE(owner_id uuid, container_id uuid, container_visit_id uuid, previous_client_id uuid, transfer_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
    SELECT o.id, o.container_id, v.id, p.client_id,
           greatest(transfer_date::timestamp AT TIME ZONE 'Europe/Moscow',
                    CASE WHEN p.effective_date = transfer_date THEN p.occurred_at + interval '1 microsecond' END,
                    CASE WHEN transfer_date = billing_today() THEN billing_now() END)
    FROM container_owner o
    JOIN container_visit_facts v ON v.receiving_order_id = o.receiving_order_id AND v.container_id = o.container_id
    LEFT JOIN service_order own ON own.id = own_order
    JOIN LATERAL (
        SELECT op.client_id, op.effective_date, op.action_at AS occurred_at
        FROM ownership_assignment_timeline op
        WHERE op.container_visit_id = v.id
          AND op.effective_date <= transfer_date
        ORDER BY op.effective_date DESC, op.action_at DESC, op.recorded_at DESC, op.ordering_id DESC
        LIMIT 1
    ) p ON true
    WHERE EXISTS (SELECT 1 FROM visit_receiving_tasks t WHERE t.receiving_order_id=v.receiving_order_id
                  AND t.container_id=v.container_id AND t.status='FINISHED') AND o.status = 'ON_TERMINAL' AND NOT v.is_cancelled AND v.shipping_date IS NULL
      AND v.receiving_date <= transfer_date AND v.receiving_date <= billing_today()
      AND p.client_id <> target_client
      AND (own.source_client_id IS NULL OR own.source_client_id = p.client_id)
      AND NOT EXISTS (
          SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id = sc.service_order_id
          WHERE sc.container_id = o.container_id AND sc.result_status='DRAFT' AND s.status = 'DRAFT' AND s.id IS DISTINCT FROM own_order
      );
$function$;

CREATE OR REPLACE FUNCTION public.apply_container_history(history_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit_facts%ROWTYPE; p container_period%ROWTYPE;
 result_id uuid; previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit_facts cv ON cv.receiving_order_id=o.receiving_order_id AND cv.container_id=o.container_id AND NOT cv.is_cancelled WHERE o.container_id=h.container_id;
 IF h.operation_type IN ('RESERVE_RECEIVING','DEPARTURE','CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION','CANCEL_DEPARTURE') THEN
  PERFORM revoke_future_ownership(h.container_id,'Исходный receiving завершён, отменён или заменён; будущая передача прекращена');
 END IF;
 SELECT op.* INTO p FROM container_period op JOIN container_owner_history sh ON sh.id=op.start_container_owner_history_id
 WHERE op.container_visit_id=v.id AND sh.occurred_at<=h.occurred_at
 ORDER BY sh.occurred_at DESC,sh.created_at DESC,sh.id DESC LIMIT 1;
 IF h.operation_type IN ('DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT max(occurred_at) INTO latest FROM container_owner_history_view WHERE container_id=h.container_id AND id<>h.id;
  IF latest>h.occurred_at THEN RAISE EXCEPTION 'Операция не может быть раньше предыдущих событий КТК' USING ERRCODE='23514'; END IF;
 END IF;
 IF h.operation_type='RESERVE_RECEIVING' THEN
  UPDATE container_owner SET receiving_order_id=h.order_id,shipping_order_id=NULL WHERE container_id=h.container_id;
 ELSIF h.operation_type='ARRIVAL' THEN
  IF NOT EXISTS(SELECT 1 FROM container_owner WHERE container_id=h.container_id AND receiving_order_id=h.order_id) OR v.id IS NOT NULL
   OR h.old_status<>'EXPECTED' THEN RAISE EXCEPTION 'Receiving cycle is not expected' USING ERRCODE='23514'; END IF;
  PERFORM check_visit_receiving_task(h.order_id,h.container_id);
  v.id:=gen_random_uuid();
  INSERT INTO container_visit(id,container_id,receiving_container_owner_history_id)
   VALUES(v.id,h.container_id,h.id);
  result_id:=gen_random_uuid();
  INSERT INTO container_period(id,container_visit_id,client_id,start_container_owner_history_id)
   VALUES(result_id,v.id,h.new_client_id,h.id);
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR v.receiving_date IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL
   OR v.receiving_date>(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date OR v.receiving_date>billing_today() THEN
   RAISE EXCEPTION 'КТК должен находиться в остатках, дата передачи не раньше receiving текущего визита' USING ERRCODE='23514';
  END IF;
  IF p.client_id IS DISTINCT FROM h.old_client_id THEN RAISE EXCEPTION 'Прежний собственник не соответствует дате передачи' USING ERRCODE='23514'; END IF;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
  result_id:=gen_random_uuid();
  INSERT INTO container_period(id,container_visit_id,client_id,start_container_owner_history_id)
   VALUES(result_id,v.id,h.new_client_id,h.id);
 ELSIF h.operation_type='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shipping_order_container WHERE shipping_order_id=h.order_id
                 AND container_id=h.container_id AND status='FINISHED') THEN
   RAISE EXCEPTION 'Shipping requires a finished container row' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_container_owner_history_id=h.id WHERE id=v.id;
  result_id:=p.id;
 ELSIF h.operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
  IF h.operation_type='CANCEL_ARRIVAL' THEN
   IF v.id IS NULL OR v.receiving_order_id<>h.order_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM container_owner WHERE container_id=h.container_id AND receiving_order_id=h.order_id) OR v.id IS NOT NULL
    THEN RAISE EXCEPTION 'Wrong receiving reservation cancellation' USING ERRCODE='23514'; END IF;
  END IF;
  result_id:=p.id;
  UPDATE container_visit SET cancellation_container_owner_history_id=h.id WHERE id=v.id;
  previous_receiving:=previous_stock_order(h.container_id,h.order_id,'RECEIVING_ORDER');
  UPDATE container_owner SET receiving_order_id=previous_receiving,
   shipping_order_id=(SELECT cv.shipping_order_id FROM container_visit_facts cv WHERE cv.container_id=h.container_id AND cv.receiving_order_id=previous_receiving)
   WHERE container_id=h.container_id;
  -- Cancellation restores the owner through its audit event; it is not a new storage assignment.
 ELSIF h.operation_type='CANCEL_DEPARTURE' THEN
  SELECT op.* INTO p FROM container_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history e ON e.id=sp.end_history_id
   WHERE op.container_visit_id=v.id AND e.order_type='SHIPPING_ORDER' AND e.order_id=h.order_id;
  IF p.id IS NULL OR v.is_cancelled OR v.shipping_date IS NULL THEN RAISE EXCEPTION 'Shipping cancellation cycle is not closed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM container_owner_history_view e JOIN container_owner_history shipping ON shipping.id=v.shipping_container_owner_history_id
   WHERE e.container_id=h.container_id AND e.operation_type='OWNER_CHANGE' AND e.new_status='DEPARTED' AND e.created_at>shipping.created_at AND (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today()) THEN
   RAISE EXCEPTION 'Нельзя отменить shipping после смены собственника вне площадки' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_container_owner_history_id=NULL WHERE id=v.id;
  UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id;
  result_id:=p.id;
 ELSE
  result_id:=p.id;
  IF h.operation_type='CANCEL_SHIPPING_RESERVATION' THEN UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id; END IF;
 END IF;
 UPDATE container_owner_history SET container_period_id=result_id WHERE id=h.id;
END $function$;

CREATE OR REPLACE FUNCTION public.check_container_visit(visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v container_visit_facts%ROWTYPE;p record;cursor_date date;found_period boolean:=false;previous_end date;event container_owner_history_view%ROWTYPE;
BEGIN
 SELECT * INTO v FROM container_visit_facts WHERE id=visit_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF v.shipping_date<v.receiving_date THEN
  RAISE EXCEPTION 'Departure precedes receiving for visit %',v.id USING ERRCODE='23514';
 END IF;
 -- Keep the underlying receiving document for the entire lifetime of the visit,
 -- even after a cancelled rail order releases its waybill.
 PERFORM 1 FROM receiving_order WHERE id=v.receiving_order_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing receiving order for visit %',v.id USING ERRCODE='23503'; END IF;
 SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.receiving_container_owner_history_id;
 IF (event.operation_type,event.container_id) IS DISTINCT FROM ('ARRIVAL',v.container_id) THEN
  RAISE EXCEPTION 'Invalid arrival for visit %',v.id USING ERRCODE='23514';
 END IF;
 IF v.shipping_container_owner_history_id IS NOT NULL THEN
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.shipping_container_owner_history_id;
  IF (event.operation_type,event.container_id) IS DISTINCT FROM ('DEPARTURE',v.container_id) OR NOT EXISTS (
   SELECT 1 FROM shipping_order_container WHERE shipping_order_id=event.order_id AND container_id=v.container_id AND status='FINISHED'
  ) THEN RAISE EXCEPTION 'Invalid departure for visit %',v.id USING ERRCODE='23514'; END IF;
 END IF;
 IF v.is_cancelled THEN
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.cancellation_container_owner_history_id;
  IF (event.operation_type,event.order_id,event.container_id) IS DISTINCT FROM ('CANCEL_ARRIVAL',v.receiving_order_id,v.container_id) THEN
   RAISE EXCEPTION 'Invalid receiving cancellation for visit %',v.id USING ERRCODE='23514';
  END IF;
  RETURN;
 END IF;
 cursor_date:=v.receiving_date;
 FOR p IN SELECT op.*,sp.end_history_id AS derived_end,(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS derived_start,h.created_at AS recorded FROM container_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history h ON h.id=op.start_container_owner_history_id
  WHERE op.container_visit_id=v.id ORDER BY h.occurred_at,h.created_at,h.id LOOP
  IF p.derived_start IS DISTINCT FROM cursor_date OR (found_period AND previous_end IS NULL) THEN RAISE EXCEPTION 'Ownership periods overlap or have gaps: %',v.id; END IF;
  PERFORM check_storage_period_boundaries(p.id);
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=p.start_container_owner_history_id;
  IF p.client_id<>event.new_client_id OR p.derived_start IS DISTINCT FROM (event.occurred_at AT TIME ZONE 'Europe/Moscow')::date THEN RAISE EXCEPTION 'Ownership period does not match its event'; END IF;
  cursor_date:=NULL;
  IF p.derived_end IS NOT NULL THEN
   SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=p.derived_end;
   cursor_date:=(event.occurred_at AT TIME ZONE 'Europe/Moscow')::date+CASE WHEN event.order_type='SHIPPING_ORDER' THEN 1 ELSE 0 END;
  END IF;
  found_period:=true;previous_end:=cursor_date;
 END LOOP;
 IF NOT found_period OR cursor_date IS DISTINCT FROM v.shipping_date+1 THEN RAISE EXCEPTION 'Ownership periods do not cover receiving/shipping: %',v.id; END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.validate_container_stock_state()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE o container_owner%ROWTYPE; v container_visit_facts%ROWTYPE;
BEGIN
 SELECT * INTO o FROM container_owner WHERE container_id=coalesce(NEW.container_id,OLD.container_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO v FROM container_visit_facts WHERE container_id=o.container_id AND receiving_order_id=o.receiving_order_id;
 IF o.status='EXPECTED' THEN
   IF v.id IS NOT NULL OR o.shipping_order_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM receiving_order WHERE id=o.receiving_order_id AND order_status='CONFIRMED') THEN
      RAISE EXCEPTION 'Expected stock requires a confirmed receiving reservation';
   END IF;
   RETURN NULL;
 END IF;
 IF o.receiving_order_id IS NOT NULL AND (v.id IS NULL OR v.cancellation_container_owner_history_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Stock must reference the actual receiving for this container';
 END IF;
 IF o.status IN ('ON_TERMINAL','RESERVED_OUT') AND (v.id IS NULL OR v.shipping_container_owner_history_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Warehouse state requires an open physical visit';
 END IF;
 IF o.status='DEPARTED' AND v.id IS NOT NULL AND v.shipping_container_owner_history_id IS NULL THEN
    RAISE EXCEPTION 'Departed stock refers to an open visit';
 END IF;
 IF (o.status='ON_TERMINAL' AND o.shipping_order_id IS NOT NULL) OR
    (o.status='RESERVED_OUT' AND o.shipping_order_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid current shipping reservation';
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.check_storage_period_sources(period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE p container_storage_period%ROWTYPE; receiving_id uuid;
        e container_owner_history_view%ROWTYPE;
BEGIN
 SELECT * INTO p FROM container_storage_period WHERE id=period_id;
 IF NOT FOUND OR p.status='CANCELLED' THEN RETURN; END IF;
 SELECT id INTO STRICT receiving_id FROM receiving_order WHERE id=storage_receiving_order(p.id) FOR KEY SHARE;
 PERFORM check_visit_receiving_task(receiving_id,p.container_id);
 SELECT * INTO e FROM container_owner_history_view WHERE id=p.end_history_id;
 IF e.operation_type='DEPARTURE' AND NOT EXISTS (
    SELECT 1 FROM shipping_order_container WHERE shipping_order_id=e.order_id AND container_id=p.container_id AND status='FINISHED'
 ) THEN RAISE EXCEPTION 'Invalid shipping source for period %',p.id USING ERRCODE='23514'; END IF;
END $function$;

-- Protect the receiving header directly through the arrival event for every visit,
-- including a cancelled visit whose original railway composition was released.
CREATE OR REPLACE FUNCTION public.validate_storage_source_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
DECLARE before_row jsonb; after_row jsonb; affected uuid[]; cid uuid; pid uuid;
BEGIN
 before_row:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 IF TG_WHEN='BEFORE' AND TG_TABLE_NAME='receiving_order'
  AND (TG_OP='DELETE' OR before_row->>'id' IS DISTINCT FROM after_row->>'id')
  AND EXISTS(SELECT 1 FROM container_visit v JOIN container_owner_history h ON h.id=v.receiving_container_owner_history_id
   WHERE h.order_id=(before_row->>'id')::uuid) THEN
  RAISE EXCEPTION 'Invalid storage origin: receiving order is referenced by history' USING ERRCODE='23503';
 END IF;
 IF TG_TABLE_NAME IN ('receiving_order_container','shipping_order_container','waybill_container') THEN
  affected:=ARRAY[(before_row->>'container_id')::uuid,(after_row->>'container_id')::uuid];
 ELSIF TG_TABLE_NAME='waybill' THEN
  SELECT array_agg(DISTINCT wc.container_id) INTO affected
  FROM waybill_railway_carriage wr JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id
  WHERE wr.waybill_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid);
 ELSIF TG_TABLE_NAME='waybill_railway_carriage' THEN
  SELECT array_agg(DISTINCT container_id) INTO affected FROM waybill_container
  WHERE waybill_railway_carriage_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid);
 ELSIF TG_TABLE_NAME='receiving_order' THEN
  SELECT array_agg(DISTINCT p.container_id) INTO affected FROM container_storage_period p
  JOIN container_owner_history_view h ON h.id=p.start_history_id
  WHERE h.operation_type='ARRIVAL' AND h.order_type='RECEIVING_ORDER'
   AND h.order_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid) AND p.status<>'CANCELLED';
 ELSE
  SELECT array_agg(DISTINCT p.container_id) INTO affected FROM container_storage_period p
  JOIN container_owner_history_view h ON h.id=p.end_history_id
  WHERE h.order_type='SHIPPING_ORDER' AND h.order_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid)
    AND p.status<>'CANCELLED';
 END IF;
 FOR cid IN SELECT DISTINCT x FROM unnest(affected) x WHERE x IS NOT NULL ORDER BY x LOOP
  IF TG_WHEN='BEFORE' THEN
   PERFORM 1 FROM container WHERE id=cid FOR UPDATE;
  ELSE
   FOR pid IN SELECT id FROM container_storage_period WHERE container_id=cid AND status<>'CANCELLED' LOOP
    PERFORM check_storage_period_sources(pid);
   END LOOP;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;

-- A cancellation is a visit boundary even when it is not the start or end of
-- a storage period. Recheck it when a referenced history event is edited.
CREATE FUNCTION validate_visit_event_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visit_id uuid;
BEGIN
    FOR visit_id IN SELECT id FROM container_visit WHERE cancellation_container_owner_history_id=NEW.id
    LOOP
        PERFORM check_container_visit(visit_id);
    END LOOP;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER visit_cancellation_event_integrity AFTER UPDATE OF order_id,container_id,order_type,old_status,new_status
    ON container_owner_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_visit_event_update();

ALTER TABLE container_visit
    DROP COLUMN receiving_order_id, DROP COLUMN receiving_order_container_id, DROP COLUMN waybill_container_id,
    DROP COLUMN shipping_order_container_id, DROP COLUMN created_at, DROP COLUMN updated_at;

COMMENT ON TABLE container_visit IS 'Физический заезд КТК от фактической приёмки до вывоза. Заявки и время определяются по событиям.';
COMMENT ON VIEW container_visit_facts IS 'Заявки и даты по событиям приёмки и вывоза. Отмена приёмки аннулирует заезд.';
COMMENT ON VIEW visit_receiving_tasks IS 'Текущий состав авто- и ЖД-поставок по заявке и КТК. После освобождения накладной её строки относятся к новой поставке.';

DO $$ BEGIN
    PERFORM check_container_visit(id) FROM container_visit;
END $$;
