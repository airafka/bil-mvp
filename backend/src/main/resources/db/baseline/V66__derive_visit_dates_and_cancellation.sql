-- One source of business dates for receipts, departures and dependent reports.
CREATE VIEW public.container_visit_facts AS
 SELECT v.id,v.container_id,v.receiving_order_id,v.receiving_order_container_id,v.waybill_container_id,
        v.receiving_container_owner_history_id,v.shipping_order_container_id,v.shipping_container_owner_history_id,
        v.cancellation_container_owner_history_id,v.created_at,v.updated_at,
        (arrival.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS receiving_date,
        (departure.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS shipping_date,
        v.cancellation_container_owner_history_id IS NOT NULL AS is_cancelled
 FROM public.container_visit v
 JOIN public.container_owner_history arrival ON arrival.id=v.receiving_container_owner_history_id
 LEFT JOIN public.container_owner_history departure ON departure.id=v.shipping_container_owner_history_id;

-- Check every visit, including cancelled visits, before removing the stored values.
DO $$ BEGIN
 IF EXISTS (
    SELECT 1 FROM container_visit v LEFT JOIN container_visit_facts f USING(id)
    WHERE f.id IS NULL OR (v.receiving_date,v.shipping_date,v.is_cancelled)
                       IS DISTINCT FROM (f.receiving_date,f.shipping_date,f.is_cancelled)
 ) THEN RAISE EXCEPTION 'Visit dates or cancellation differ from their history events'; END IF;
END $$;

CREATE OR REPLACE VIEW container_owner_current AS
 SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
        v.id AS container_visit_id,o.version,o.receiving_order_id,o.client_id
 FROM container_owner o LEFT JOIN container_visit v ON v.container_id=o.container_id
   AND v.receiving_order_id=o.receiving_order_id AND v.cancellation_container_owner_history_id IS NULL AND o.status<>'EXPECTED';

DROP INDEX container_visit_one_current;
CREATE UNIQUE INDEX container_visit_one_current ON container_visit(container_id)
 WHERE cancellation_container_owner_history_id IS NULL AND shipping_container_owner_history_id IS NULL;
DROP INDEX container_visit_history;
CREATE INDEX container_visit_history ON container_visit(container_id,id);
ALTER TABLE container_visit ADD CONSTRAINT container_visit_receiving_source CHECK
 (cancellation_container_owner_history_id IS NOT NULL OR num_nonnulls(receiving_order_container_id,waybill_container_id)=1);


CREATE OR REPLACE FUNCTION public.require_physical_ownership_visit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF NEW.record_type<>'STORAGE' OR NEW.container_visit_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM container_visit v WHERE v.id=NEW.container_visit_id AND v.container_id=NEW.container_id AND v.cancellation_container_owner_history_id IS NULL AND v.shipping_container_owner_history_id IS NULL) THEN
  RAISE EXCEPTION 'New ownership assignments require an actual receiving visit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;

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
    JOIN receiving_order r ON r.id = v.receiving_order_id AND r.order_status = 'COMPLETED'
    LEFT JOIN service_order own ON own.id = own_order
    JOIN LATERAL (
        SELECT op.client_id, op.effective_date, op.action_at AS occurred_at
        FROM ownership_assignment_timeline op
        WHERE op.container_visit_id = v.id AND NOT op.is_cancelled AND NOT op.is_withdrawn
          AND op.effective_date <= transfer_date
        ORDER BY op.effective_date DESC, op.action_at DESC, op.recorded_at DESC, op.ordering_id DESC
        LIMIT 1
    ) p ON true
    WHERE o.status = 'ON_TERMINAL' AND NOT v.is_cancelled AND v.shipping_date IS NULL
      AND v.receiving_date <= transfer_date AND v.receiving_date <= billing_today()
      AND p.client_id <> target_client
      AND (own.source_client_id IS NULL OR own.source_client_id = p.client_id)
      AND NOT EXISTS (
          SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id = sc.service_order_id
          WHERE sc.container_id = o.container_id AND s.status = 'DRAFT' AND s.id IS DISTINCT FROM own_order
      );
$function$;

CREATE OR REPLACE FUNCTION public.withdraw_ownership_period(period_id uuid, reason text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE p ownership_assignment_timeline%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM ownership_assignment_timeline WHERE id=period_id;
 IF p.is_withdrawn THEN RETURN; END IF;
 IF p.effective_date<=billing_today() THEN RAISE EXCEPTION 'Нельзя отозвать передачу с наступившей датой' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM container_visit_facts WHERE id=p.container_visit_id AND shipping_date>=p.effective_date)
 OR EXISTS(SELECT 1 FROM ownership_assignment_timeline n WHERE n.container_id=p.container_id AND NOT n.is_withdrawn
    AND NOT n.is_cancelled AND (n.effective_date,n.action_at,n.recorded_at,n.ordering_id)>
                            (p.effective_date,p.action_at,p.recorded_at,p.ordering_id))
 THEN RAISE EXCEPTION 'Сначала отмените последующие операции КТК' USING ERRCODE='23514'; END IF;
 UPDATE container_period SET is_withdrawn=true,withdrawn_at=billing_now(),withdrawal_reason=reason,updated_at=billing_now() WHERE id=p.id;
END $function$;

CREATE OR REPLACE FUNCTION public.validate_container_stock_state()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE o container_owner%ROWTYPE; v container_visit%ROWTYPE;
BEGIN
 SELECT * INTO o FROM container_owner WHERE container_id=coalesce(NEW.container_id,OLD.container_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO v FROM container_visit WHERE container_id=o.container_id AND receiving_order_id=o.receiving_order_id;
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
 IF v.is_cancelled THEN
  IF EXISTS(SELECT 1 FROM container_period WHERE container_visit_id=v.id AND NOT is_cancelled) THEN RAISE EXCEPTION 'Cancelled receiving has active ownership'; END IF;
  RETURN;
 END IF;
 IF v.receiving_order_container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM receiving_order_container r WHERE r.id=v.receiving_order_container_id AND r.receiving_order_id=v.receiving_order_id AND r.container_id=v.container_id)
  OR v.waybill_container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM waybill_container wc JOIN waybill_railway_carriage wr ON wr.id=wc.waybill_railway_carriage_id JOIN waybill w ON w.id=wr.waybill_id WHERE wc.id=v.waybill_container_id AND wc.container_id=v.container_id AND w.receiving_order_id=v.receiving_order_id) THEN
  RAISE EXCEPTION 'Receiving row belongs to another visit' USING ERRCODE='23514';
 END IF;
 SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.receiving_container_owner_history_id;
 IF event.container_id<>v.container_id OR event.order_id<>v.receiving_order_id OR event.operation_type<>'ARRIVAL' THEN RAISE EXCEPTION 'Invalid receiving event for cycle %',v.id; END IF;
 IF v.shipping_date IS NOT NULL THEN
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.shipping_container_owner_history_id;
  IF event.container_id<>v.container_id OR event.operation_type<>'DEPARTURE'
   OR NOT EXISTS(SELECT 1 FROM shipping_order_container WHERE id=v.shipping_order_container_id AND shipping_order_id=event.order_id AND container_id=v.container_id) THEN RAISE EXCEPTION 'Invalid shipping event for cycle %',v.id; END IF;
 END IF;
 cursor_date:=v.receiving_date;
 FOR p IN SELECT op.*,sp.end_history_id AS derived_end,op.effective_date AS derived_start,h.created_at AS recorded FROM container_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history h ON h.id=op.start_container_owner_history_id
  WHERE op.container_visit_id=v.id AND NOT op.is_cancelled ORDER BY op.effective_date,h.occurred_at,h.created_at,h.id LOOP
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

CREATE OR REPLACE FUNCTION public.apply_container_history(history_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit_facts%ROWTYPE; p container_period%ROWTYPE;
 row_id uuid; rail_id uuid; count_rows integer; result_id uuid; previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit_facts cv ON cv.receiving_order_id=o.receiving_order_id AND cv.container_id=o.container_id AND NOT cv.is_cancelled WHERE o.container_id=h.container_id;
 IF h.operation_type IN ('RESERVE_RECEIVING','DEPARTURE','CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION','CANCEL_DEPARTURE') THEN
  PERFORM revoke_future_ownership(h.container_id,'Исходный receiving завершён, отменён или заменён; будущая передача прекращена');
 END IF;
 SELECT op.* INTO p FROM container_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history sh ON sh.id=sp.start_history_id
 WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND op.effective_date<=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date
 ORDER BY op.effective_date DESC,sh.occurred_at DESC,sh.created_at DESC LIMIT 1;
 IF h.operation_type IN ('DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT max(occurred_at) INTO latest FROM container_owner_history_view WHERE container_id=h.container_id AND id<>h.id AND (order_type<>'SERVICE_ORDER' OR
 (occurred_at<=h.occurred_at AND NOT EXISTS(SELECT 1 FROM container_period op WHERE op.start_container_owner_history_id=container_owner_history_view.id AND op.is_withdrawn)));
  IF latest>h.occurred_at THEN RAISE EXCEPTION 'Операция не может быть раньше предыдущих событий КТК' USING ERRCODE='23514'; END IF;
 END IF;
 IF h.operation_type='RESERVE_RECEIVING' THEN
  UPDATE service_order_container SET result_status='SKIPPED',result_reason='Начат новый receiving; прежняя передача не переносится на него'
   WHERE container_id=h.container_id AND result_status IN ('PLANNED','BLOCKED');
  UPDATE container_owner SET receiving_order_id=h.order_id,shipping_order_id=NULL WHERE container_id=h.container_id;
 ELSIF h.operation_type='ARRIVAL' THEN
  IF NOT EXISTS(SELECT 1 FROM container_owner WHERE container_id=h.container_id AND receiving_order_id=h.order_id) OR v.id IS NOT NULL
   OR h.old_status<>'EXPECTED' THEN RAISE EXCEPTION 'Receiving cycle is not expected' USING ERRCODE='23514'; END IF;
  row_id:=NULL;rail_id:=NULL;
  IF (SELECT transport_type FROM receiving_order WHERE id=h.order_id)='VEHICLE' THEN
   SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM receiving_order_container WHERE receiving_order_id=h.order_id AND container_id=h.container_id;
  ELSE
   SELECT count(*),(array_agg(wc.id))[1] INTO count_rows,rail_id FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
    JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=h.order_id AND wc.container_id=h.container_id;
  END IF;
  IF count_rows<>1 THEN RAISE EXCEPTION 'Receiving requires exactly one container row' USING ERRCODE='23514'; END IF;
  v.id:=gen_random_uuid();
  INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id,receiving_container_owner_history_id)
   VALUES(v.id,h.container_id,h.order_id,row_id,rail_id,h.id);
  result_id:=gen_random_uuid();
  INSERT INTO container_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
   VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR v.receiving_date IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL
   OR v.receiving_date>(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date OR v.receiving_date>billing_today() THEN
   RAISE EXCEPTION 'КТК должен находиться в остатках, дата передачи не раньше receiving текущего визита' USING ERRCODE='23514';
  END IF;
  IF p.client_id IS DISTINCT FROM h.old_client_id THEN RAISE EXCEPTION 'Прежний собственник не соответствует дате передачи' USING ERRCODE='23514'; END IF;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
  result_id:=gen_random_uuid();
  INSERT INTO container_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
   VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
 ELSIF h.operation_type='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM shipping_order_container WHERE shipping_order_id=h.order_id AND container_id=h.container_id AND status='FINISHED';
  IF count_rows<>1 THEN RAISE EXCEPTION 'Shipping requires exactly one finished row' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_order_container_id=row_id,
   shipping_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  result_id:=p.id;
  UPDATE service_order_container SET result_status='SKIPPED',result_reason='КТК вывезен до исполнения передачи; план не переносится на новый receiving'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
 ELSIF h.operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
  IF h.operation_type='CANCEL_ARRIVAL' THEN
   IF v.id IS NULL OR v.receiving_order_id<>h.order_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM container_owner WHERE container_id=h.container_id AND receiving_order_id=h.order_id) OR v.id IS NOT NULL
    THEN RAISE EXCEPTION 'Wrong receiving reservation cancellation' USING ERRCODE='23514'; END IF;
  END IF;
  result_id:=p.id;
  UPDATE container_visit SET cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_period SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE container_visit_id=v.id;
  UPDATE service_order_container SET result_status='CANCELLED',result_reason='Receiving отменён; передача не исполняется'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
  previous_receiving:=previous_stock_order(h.container_id,h.order_id,'RECEIVING_ORDER');
  UPDATE container_owner SET receiving_order_id=previous_receiving,
   shipping_order_id=(SELECT sc.shipping_order_id FROM container_visit cv JOIN shipping_order_container sc ON sc.id=cv.shipping_order_container_id WHERE cv.container_id=h.container_id AND cv.receiving_order_id=previous_receiving)
   WHERE container_id=h.container_id;
  -- Cancellation restores the owner through its audit event; it is not a new storage assignment.
 ELSIF h.operation_type='CANCEL_DEPARTURE' THEN
  SELECT op.* INTO p FROM container_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history e ON e.id=sp.end_history_id
   WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND e.order_type='SHIPPING_ORDER' AND e.order_id=h.order_id;
  IF p.id IS NULL OR v.is_cancelled OR v.shipping_date IS NULL THEN RAISE EXCEPTION 'Shipping cancellation cycle is not closed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM container_owner_history_view e JOIN container_owner_history shipping ON shipping.id=v.shipping_container_owner_history_id
   WHERE e.container_id=h.container_id AND e.operation_type='OWNER_CHANGE' AND e.new_status='DEPARTED' AND e.created_at>shipping.created_at AND (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today() AND NOT EXISTS(SELECT 1 FROM container_period removed WHERE removed.start_container_owner_history_id=e.id AND removed.is_withdrawn)) THEN
   RAISE EXCEPTION 'Нельзя отменить shipping после смены собственника вне площадки' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_order_container_id=NULL,shipping_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id;
  result_id:=p.id;
 ELSE
  result_id:=p.id;
  IF h.operation_type='CANCEL_SHIPPING_RESERVATION' THEN UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id; END IF;
 END IF;
 UPDATE container_owner_history SET container_period_id=result_id WHERE id=h.id;
END $function$;

ALTER TABLE public.container_visit
 DROP COLUMN receiving_date,
 DROP COLUMN shipping_date,
 DROP COLUMN is_cancelled;
COMMENT ON VIEW public.container_visit_facts IS 'Фактические даты приёмки и вывоза по Москве и признак отмены заезда, вычисленные по ссылкам на события истории.';
