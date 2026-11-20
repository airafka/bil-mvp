-- Dated ownership may be inserted into the current physical visit.
-- Audit snapshots stay immutable; chronological predecessor is derived for display.
CREATE FUNCTION ownership_transfer_candidates(transfer_date date,target_client uuid,own_order uuid)
RETURNS TABLE(owner_id uuid,container_id uuid,container_visit_id uuid,previous_client_id uuid,transfer_at timestamptz)
LANGUAGE sql STABLE AS $$
 SELECT o.id,o.container_id,v.id,p.client_id,
 greatest(transfer_date::timestamp AT TIME ZONE 'Europe/Moscow',
   CASE WHEN p.effective_date=transfer_date THEN p.occurred_at+interval '1 microsecond' END,
   CASE WHEN transfer_date=billing_today() THEN billing_now() END)
 FROM container_owner o JOIN container_visit v ON v.id=o.container_visit_id
 JOIN LATERAL(SELECT op.client_id,op.effective_date,h.occurred_at
   FROM container_ownership_period op JOIN container_owner_history h ON h.id=op.start_container_owner_history_id
   WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND NOT op.is_withdrawn AND op.effective_date<=transfer_date
   ORDER BY op.effective_date DESC,h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1)p ON true
 WHERE o.status IN ('ON_TERMINAL','RESERVED_OUT') AND NOT v.is_cancelled AND v.shipping_date IS NULL
   AND v.receiving_date<=transfer_date AND v.receiving_date<=billing_today() AND p.client_id<>target_client
   AND NOT EXISTS(SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
     WHERE sc.container_id=o.container_id AND s.status='DRAFT' AND s.id IS DISTINCT FROM own_order)
$$;

CREATE VIEW container_owner_history_timeline AS
 SELECT h.*,coalesce(previous.client_id,h.old_client_id) AS timeline_old_client_id
 FROM container_owner_history_view h
 LEFT JOIN LATERAL(SELECT op.client_id FROM container_storage_period sp
   JOIN container_ownership_period op ON op.id=sp.id
   WHERE h.operation_type='OWNER_CHANGE' AND sp.end_history_id=h.id) previous ON true;

COMMENT ON VIEW container_owner_history_timeline IS 'История с предыдущим собственником по актуальной временной цепочке. Исходный old_client_id остаётся снимком подтверждения.';

CREATE OR REPLACE FUNCTION public.apply_container_history(history_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit%ROWTYPE; p container_ownership_period%ROWTYPE;
 row_id uuid; rail_id uuid; count_rows integer; result_id uuid; previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit cv ON cv.id=o.container_visit_id WHERE o.container_id=h.container_id;
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
  row_id:=NULL;rail_id:=NULL;
  IF (SELECT transport_type FROM receiving_order WHERE id=h.order_id)='VEHICLE' THEN
   SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM receiving_order_container WHERE receiving_order_id=h.order_id AND container_id=h.container_id;
  ELSE
   SELECT count(*),(array_agg(wc.id))[1] INTO count_rows,rail_id FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
    JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=h.order_id AND wc.container_id=h.container_id;
  END IF;
  IF count_rows<>1 THEN RAISE EXCEPTION 'Receiving requires exactly one container row' USING ERRCODE='23514'; END IF;
  v.id:=gen_random_uuid();
  INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id)
   VALUES(v.id,h.container_id,h.order_id,row_id,rail_id);
  UPDATE container_owner SET container_visit_id=v.id,shipping_order_id=NULL WHERE container_id=h.container_id;
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id)
   VALUES(gen_random_uuid(),h.container_id,v.id,h.new_client_id,'EXPECTED',h.id);
 ELSIF h.operation_type='ARRIVAL' THEN
  IF v.id IS NULL OR v.receiving_order_id<>h.order_id OR v.is_cancelled OR v.receiving_date IS NOT NULL THEN RAISE EXCEPTION 'Receiving cycle is not expected' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET receiving_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,receiving_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  result_id:=gen_random_uuid();
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
   VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR v.receiving_date IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL
   OR v.receiving_date>(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date OR v.receiving_date>billing_today() THEN
   RAISE EXCEPTION 'КТК должен находиться в остатках, дата передачи не раньше receiving текущего визита' USING ERRCODE='23514';
  END IF;
  IF p.client_id IS DISTINCT FROM h.old_client_id THEN RAISE EXCEPTION 'Прежний собственник не соответствует дате передачи' USING ERRCODE='23514'; END IF;
  IF h.new_status IN ('ON_TERMINAL','RESERVED_OUT') THEN
   IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
    VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
  ELSIF h.new_status='EXPECTED' THEN
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id)
    VALUES(result_id,h.container_id,v.id,h.new_client_id,'EXPECTED',h.id);
  ELSE
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id)
    VALUES(result_id,h.container_id,h.new_client_id,'OUTSIDE_STORAGE',h.id);
  END IF;
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
  IF v.id IS NULL OR v.receiving_order_id<>h.order_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  result_id:=p.id;
  UPDATE container_visit SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE container_visit_id=v.id;
  UPDATE service_order_container SET result_status='CANCELLED',result_reason='Receiving отменён; передача не исполняется'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
  previous_receiving:=previous_stock_order(h.container_id,h.order_id,'RECEIVING_ORDER');
  UPDATE container_owner SET container_visit_id=(SELECT id FROM container_visit WHERE container_id=h.container_id AND receiving_order_id=previous_receiving),
   shipping_order_id=(SELECT sc.shipping_order_id FROM container_visit cv JOIN shipping_order_container sc ON sc.id=cv.shipping_order_container_id WHERE cv.container_id=h.container_id AND cv.receiving_order_id=previous_receiving)
   WHERE container_id=h.container_id;
  INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id)
   VALUES(gen_random_uuid(),h.container_id,h.new_client_id,'OUTSIDE_STORAGE',h.id);
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
CREATE OR REPLACE FUNCTION public.check_storage_period_boundaries(period_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
 p container_storage_period%ROWTYPE;
 a container_owner_history_view%ROWTYPE;
 z container_owner_history_view%ROWTYPE;
 neighbour container_storage_period%ROWTYPE;
 area uuid;
 origin_order uuid;
BEGIN
 SELECT * INTO p FROM container_storage_period WHERE id=period_id;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM storage_arrival_history(p.id);
 origin_order:=storage_receiving_order(p.id);
 PERFORM check_storage_period_sources(p.id);
 SELECT terminal_area_catalog_id INTO STRICT area FROM receiving_order WHERE id=origin_order FOR KEY SHARE;
 SELECT * INTO a FROM container_owner_history_view WHERE id=p.start_history_id;
 IF a.operation_type NOT IN ('ARRIVAL','OWNER_CHANGE') OR a.cancellation
  OR a.container_id IS DISTINCT FROM p.container_id
  OR a.occurred_at IS NULL OR a.storage_period_id IS DISTINCT FROM p.id THEN
  RAISE EXCEPTION 'Invalid storage start event for %',p.id USING ERRCODE='23514';
 END IF;
 IF a.operation_type='ARRIVAL' THEN
  IF a.order_type<>'RECEIVING_ORDER' OR a.order_id IS DISTINCT FROM origin_order THEN
   RAISE EXCEPTION 'Invalid storage receiving order for %',p.id USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO neighbour FROM container_storage_period WHERE end_history_id=a.id;
  IF NOT FOUND OR neighbour.id=p.id OR a.order_type<>'SERVICE_ORDER'
   OR a.old_client_id IS NOT DISTINCT FROM a.new_client_id
   OR a.old_status NOT IN ('EXPECTED','ON_TERMINAL','RESERVED_OUT') OR a.new_status<>a.old_status
   OR (neighbour.container_id,storage_receiving_order(neighbour.id))
     IS DISTINCT FROM (p.container_id,origin_order)
   OR (neighbour.status='CANCELLED')<>(p.status='CANCELLED') THEN
   RAISE EXCEPTION 'Invalid storage ownership predecessor for %',p.id USING ERRCODE='23514';
  END IF;
 END IF;
 IF p.end_history_id IS NULL THEN RETURN; END IF;
 SELECT * INTO z FROM container_owner_history_view WHERE id=p.end_history_id;
 IF z.operation_type NOT IN ('DEPARTURE','OWNER_CHANGE') OR z.cancellation
  OR z.container_id IS DISTINCT FROM p.container_id OR (z.operation_type='DEPARTURE' AND (SELECT terminal_area_catalog_id FROM shipping_order WHERE id=z.order_id) IS DISTINCT FROM area)
  OR z.occurred_at IS NULL OR z.occurred_at<a.occurred_at THEN
  RAISE EXCEPTION 'Invalid storage end event for %',p.id USING ERRCODE='23514';
 END IF;
 IF z.operation_type='DEPARTURE' THEN
  IF p.status<>'CLOSED' OR z.order_type<>'SHIPPING_ORDER' OR z.storage_period_id IS DISTINCT FROM p.id THEN
   RAISE EXCEPTION 'Departure requires its exact shipping row for %',p.id USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO neighbour FROM container_storage_period WHERE start_history_id=z.id;
  IF NOT FOUND OR neighbour.id=p.id
   OR z.storage_period_id IS DISTINCT FROM neighbour.id OR (neighbour.status='CANCELLED')<>(p.status='CANCELLED') THEN
   RAISE EXCEPTION 'Invalid storage ownership successor for %',p.id USING ERRCODE='23514';
  END IF;
  -- old_client_id records what was known at confirmation. A later backdated
  -- insertion changes the chronological predecessor without rewriting that audit.
 END IF;
END $$;
