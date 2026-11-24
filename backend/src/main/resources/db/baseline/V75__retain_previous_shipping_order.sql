-- A receiving operation updates its own order reference. The stock transition owns
-- shipping_order_id, including restoration of the previous shipment on cancellation.
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
  UPDATE container_owner SET receiving_order_id=h.order_id WHERE container_id=h.container_id;
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
  UPDATE container_owner SET receiving_order_id=previous_receiving
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
  result_id:=p.id;
 ELSE
  result_id:=p.id;
 END IF;
 UPDATE container_owner_history SET container_period_id=result_id WHERE id=h.id;
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
 -- In a free or expected state this reference can point to a previous physical departure.
 IF o.status IN ('EXPECTED','ON_TERMINAL') AND o.shipping_order_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM container_visit_facts previous_visit
                    WHERE previous_visit.container_id=o.container_id
                      AND previous_visit.shipping_order_id=o.shipping_order_id AND NOT previous_visit.is_cancelled) THEN
    RAISE EXCEPTION 'Previous shipping order must have a physical departure for this container' USING ERRCODE='23514';
 END IF;
 IF o.status='EXPECTED' THEN
   IF v.id IS NOT NULL OR NOT EXISTS (
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
 IF o.status='RESERVED_OUT' AND o.shipping_order_id IS NULL THEN
    RAISE EXCEPTION 'Invalid current shipping reservation';
 END IF;
 RETURN NULL;
END $function$;

-- V74 cleared shipping_order_id at the next reservation for receiving. Recover it
-- only from a physical departure still attached to a non-cancelled visit.
WITH previous_shipping AS (
    SELECT DISTINCT ON (v.container_id) v.container_id, d.order_id
    FROM container_visit v
    JOIN container_owner_history d ON d.id=v.shipping_container_owner_history_id
    WHERE v.cancellation_container_owner_history_id IS NULL
    ORDER BY v.container_id, d.created_at DESC, d.id DESC
)
UPDATE container_owner o SET shipping_order_id=p.order_id
FROM previous_shipping p
WHERE p.container_id=o.container_id AND o.status IN ('EXPECTED','ON_TERMINAL') AND o.shipping_order_id IS NULL;

COMMENT ON TABLE container_owner IS 'Текущий собственник и складской статус КТК, ссылки на последнюю поставку и вывоз.';
COMMENT ON COLUMN container_owner.shipping_order_id IS 'Текущий вывоз при резерве или выбытии, предыдущий действующий вывоз после новой поставки или отмены вывоза.';
COMMENT ON TABLE container_visit IS 'Физический заезд одного КТК. Границы заезда определяют события приёмки, вывоза и отмены в container_owner_history.';
COMMENT ON TABLE container_period IS 'Период хранения у одного собственника в пределах заезда, начиная с события приёмки или смены собственника.';
