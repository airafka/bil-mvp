-- Move the document reference onto the register. The unique (receiving_order_id,
-- container_id) pair identifies the visit after receipt, including a closed visit.
CREATE TEMP TABLE stock_before_v64 ON COMMIT DROP AS SELECT * FROM container_owner_current;
CREATE TEMP TABLE effective_before_v64 ON COMMIT DROP AS SELECT * FROM container_owner_effective;
UPDATE container_owner o SET receiving_order_id=v.receiving_order_id
FROM container_visit v WHERE v.id=o.container_visit_id AND o.receiving_order_id IS DISTINCT FROM v.receiving_order_id;

CREATE OR REPLACE VIEW container_owner_current AS
 SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
        v.id AS container_visit_id,o.version,o.receiving_order_id,o.client_id
 FROM container_owner o LEFT JOIN container_visit v ON v.container_id=o.container_id
   AND v.receiving_order_id=o.receiving_order_id AND NOT v.is_cancelled AND o.status<>'EXPECTED';

CREATE OR REPLACE VIEW container_owner_effective AS
 SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,o.container_visit_id,o.version,
  o.receiving_order_id,p.client_id
 FROM container_owner_current o
 LEFT JOIN LATERAL(
  SELECT candidate.client_id FROM (
   SELECT op.client_id,op.effective_date,op.action_at AS occurred_at,op.recorded_at AS created_at,op.ordering_id AS id
   FROM ownership_assignment_timeline op
   WHERE op.container_id=o.container_id AND NOT op.is_cancelled AND NOT op.is_withdrawn
   UNION ALL
   SELECT h.new_client_id,(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.occurred_at,h.created_at,h.id
   FROM container_owner_history_view h
   WHERE h.container_id=o.container_id AND
    ((o.status='EXPECTED' AND h.order_id=o.receiving_order_id AND h.operation_type='RESERVE_RECEIVING')
     OR h.operation_type IN ('CANCEL_RECEIVING_RESERVATION','CANCEL_ARRIVAL'))
    AND NOT EXISTS(SELECT 1 FROM container_ownership_period old WHERE old.start_container_owner_history_id=h.id)
  ) candidate WHERE candidate.effective_date<=billing_today()
  ORDER BY candidate.effective_date DESC,candidate.occurred_at DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1
 ) p ON true;

CREATE OR REPLACE FUNCTION ownership_transfer_candidates(transfer_date date, target_client uuid, own_order uuid)
RETURNS TABLE(owner_id uuid, container_id uuid, container_visit_id uuid, previous_client_id uuid, transfer_at timestamptz)
LANGUAGE sql STABLE AS $$
    SELECT o.id, o.container_id, v.id, p.client_id,
           greatest(transfer_date::timestamp AT TIME ZONE 'Europe/Moscow',
                    CASE WHEN p.effective_date = transfer_date THEN p.occurred_at + interval '1 microsecond' END,
                    CASE WHEN transfer_date = billing_today() THEN billing_now() END)
    FROM container_owner o
    JOIN container_visit v ON v.receiving_order_id = o.receiving_order_id AND v.container_id = o.container_id
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
$$;

CREATE OR REPLACE FUNCTION validate_container_stock_state() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF o.receiving_order_id IS NOT NULL AND (v.id IS NULL OR v.is_cancelled) THEN
    RAISE EXCEPTION 'Stock must reference the actual receiving for this container';
 END IF;
 IF o.status IN ('ON_TERMINAL','RESERVED_OUT') AND (v.id IS NULL OR v.shipping_date IS NOT NULL) THEN
    RAISE EXCEPTION 'Warehouse state requires an open physical visit';
 END IF;
 IF o.status='DEPARTED' AND v.id IS NOT NULL AND v.shipping_date IS NULL THEN
    RAISE EXCEPTION 'Departed stock refers to an open visit';
 END IF;
 IF (o.status='ON_TERMINAL' AND o.shipping_order_id IS NOT NULL) OR
    (o.status='RESERVED_OUT' AND o.shipping_order_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid current shipping reservation';
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.apply_container_history(history_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit%ROWTYPE; p container_ownership_period%ROWTYPE;
 row_id uuid; rail_id uuid; count_rows integer; result_id uuid; previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit cv ON cv.receiving_order_id=o.receiving_order_id AND cv.container_id=o.container_id AND NOT cv.is_cancelled WHERE o.container_id=h.container_id;
 IF h.operation_type IN ('RESERVE_RECEIVING','DEPARTURE','CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION','CANCEL_DEPARTURE') THEN
  PERFORM revoke_future_ownership(h.container_id,'Исходный receiving завершён, отменён или заменён; будущая передача прекращена');
 END IF;
 SELECT op.* INTO p FROM container_ownership_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history sh ON sh.id=sp.start_history_id
 WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND op.effective_date<=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date
 ORDER BY op.effective_date DESC,sh.occurred_at DESC,sh.created_at DESC LIMIT 1;
 IF h.operation_type IN ('DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT max(occurred_at) INTO latest FROM container_owner_history_view WHERE container_id=h.container_id AND id<>h.id AND (order_type<>'SERVICE_ORDER' OR
 (occurred_at<=h.occurred_at AND NOT EXISTS(SELECT 1 FROM container_ownership_period op WHERE op.start_container_owner_history_id=container_owner_history_view.id AND op.is_withdrawn)));
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
  INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id,receiving_date,receiving_container_owner_history_id)
   VALUES(v.id,h.container_id,h.order_id,row_id,rail_id,(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
  result_id:=gen_random_uuid();
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
   VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR v.receiving_date IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL
   OR v.receiving_date>(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date OR v.receiving_date>billing_today() THEN
   RAISE EXCEPTION 'КТК должен находиться в остатках, дата передачи не раньше receiving текущего визита' USING ERRCODE='23514';
  END IF;
  IF p.client_id IS DISTINCT FROM h.old_client_id THEN RAISE EXCEPTION 'Прежний собственник не соответствует дате передачи' USING ERRCODE='23514'; END IF;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
  result_id:=gen_random_uuid();
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
   VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
 ELSIF h.operation_type='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM shipping_order_container WHERE shipping_order_id=h.order_id AND container_id=h.container_id AND status='FINISHED';
  IF count_rows<>1 THEN RAISE EXCEPTION 'Shipping requires exactly one finished row' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,shipping_order_container_id=row_id,
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
  UPDATE container_visit SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE container_visit_id=v.id;
  UPDATE service_order_container SET result_status='CANCELLED',result_reason='Receiving отменён; передача не исполняется'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
  previous_receiving:=previous_stock_order(h.container_id,h.order_id,'RECEIVING_ORDER');
  UPDATE container_owner SET receiving_order_id=previous_receiving,
   shipping_order_id=(SELECT sc.shipping_order_id FROM container_visit cv JOIN shipping_order_container sc ON sc.id=cv.shipping_order_container_id WHERE cv.container_id=h.container_id AND cv.receiving_order_id=previous_receiving)
   WHERE container_id=h.container_id;
  -- Cancellation restores the owner through its audit event; it is not a new storage assignment.
 ELSIF h.operation_type='CANCEL_DEPARTURE' THEN
  SELECT op.* INTO p FROM container_ownership_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history e ON e.id=sp.end_history_id
   WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND e.order_type='SHIPPING_ORDER' AND e.order_id=h.order_id;
  IF p.id IS NULL OR v.is_cancelled OR v.shipping_date IS NULL THEN RAISE EXCEPTION 'Shipping cancellation cycle is not closed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM container_owner_history_view e JOIN container_owner_history shipping ON shipping.id=v.shipping_container_owner_history_id
   WHERE e.container_id=h.container_id AND e.operation_type='OWNER_CHANGE' AND e.new_status='DEPARTED' AND e.created_at>shipping.created_at AND (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today() AND NOT EXISTS(SELECT 1 FROM container_ownership_period removed WHERE removed.start_container_owner_history_id=e.id AND removed.is_withdrawn)) THEN
   RAISE EXCEPTION 'Нельзя отменить shipping после смены собственника вне площадки' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_date=NULL,shipping_order_container_id=NULL,shipping_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id;
  result_id:=p.id;
 ELSE
  result_id:=p.id;
  IF h.operation_type='CANCEL_SHIPPING_RESERVATION' THEN UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id; END IF;
 END IF;
 UPDATE container_owner_history SET storage_period_id=result_id WHERE id=h.id;
END $$;

-- Verify both public projections, including owner, document and derived visit, before retiring the redundant column.
DO $$ BEGIN
 IF EXISTS ((TABLE stock_before_v64 EXCEPT ALL TABLE container_owner_current)
    UNION ALL (TABLE container_owner_current EXCEPT ALL TABLE stock_before_v64))
 OR EXISTS ((TABLE effective_before_v64 EXCEPT ALL TABLE container_owner_effective)
    UNION ALL (TABLE container_owner_effective EXCEPT ALL TABLE effective_before_v64)) THEN
   RAISE EXCEPTION 'Receiving reference migration changed current stock or ownership';
 END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE container_owner DROP COLUMN container_visit_id;
COMMENT ON COLUMN container_owner.receiving_order_id IS 'Текущая поставка КТК. Сохраняется после приёмки, при передаче и вывозе. При отмене поставки восстанавливается предыдущая действующая поставка, если она была.';
COMMENT ON TABLE container_visit IS 'Фактический заезд КТК. Создаётся при выполнении поставки. Пара receiving_order_id и container_id однозначно определяет заезд.';
