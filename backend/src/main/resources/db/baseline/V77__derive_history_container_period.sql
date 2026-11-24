-- Keep the history API and dependent views on the same event/period UUIDs.
-- Flyway runs the comparison, function changes and DROP COLUMN in one transaction.
LOCK TABLE container_owner_history, container_visit, container_period IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE VIEW container_owner_history_view AS
SELECT h.id, h.new_client_id, h.old_client_id, h.container_id, h.order_id, h.order_type,
       h.new_status, h.old_status, h.created_at, h.created_by, h.updated_at, h.updated_by, h.occurred_at,
       CASE
           WHEN kind.operation_type IN ('ARRIVAL','OWNER_CHANGE') THEN
               (SELECT p.id FROM container_period p WHERE p.start_container_owner_history_id=h.id)
           WHEN kind.operation_type IN ('RESERVE_RECEIVING','CANCEL_RECEIVING_RESERVATION') THEN NULL
           ELSE (
               -- Reconstruct the visit known when this event was recorded. Cancelling a later
               -- receipt can restore an earlier visit, including for cancellation of its departure.
               SELECT p.id FROM container_period p
               JOIN container_owner_history start_event ON start_event.id=p.start_container_owner_history_id
               WHERE p.container_visit_id=(
                   SELECT v.id FROM container_visit v
                   JOIN container_owner_history arrival ON arrival.id=v.receiving_container_owner_history_id
                   LEFT JOIN container_owner_history cancelled ON cancelled.id=v.cancellation_container_owner_history_id
                   WHERE v.container_id=h.container_id AND arrival.created_at<=h.created_at
                     AND (cancelled.id IS NULL OR cancelled.created_at>=h.created_at)
                   ORDER BY arrival.created_at DESC LIMIT 1
               )
               -- A later backdated transfer changes the storage timeline, but was unknown to this event.
               AND start_event.created_at<=h.created_at AND start_event.occurred_at<=h.occurred_at
               ORDER BY start_event.occurred_at DESC, start_event.created_at DESC, start_event.id DESC LIMIT 1
           )
       END AS container_period_id,
       kind.operation_type,
       kind.operation_type IN ('CANCEL_ARRIVAL','CANCEL_DEPARTURE','CANCEL_RECEIVING_RESERVATION','CANCEL_SHIPPING_RESERVATION') AS cancellation
FROM container_owner_history h
CROSS JOIN LATERAL (SELECT history_operation_type(h.order_type,h.old_status,h.new_status) AS operation_type) kind;

DO $$
DECLARE mismatch record;
BEGIN
    SELECT h.id, h.container_id, v.operation_type, h.container_period_id AS stored, v.container_period_id AS derived
    INTO mismatch FROM container_owner_history h JOIN container_owner_history_view v USING (id)
    WHERE h.container_period_id IS DISTINCT FROM v.container_period_id LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'V77: history period differs for event: %', row_to_json(mismatch);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.apply_container_history(history_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit_facts%ROWTYPE; p container_period%ROWTYPE;
 previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit_facts cv ON cv.receiving_order_id=o.receiving_order_id AND cv.container_id=o.container_id AND NOT cv.is_cancelled WHERE o.container_id=h.container_id;
 IF h.operation_type IN ('RESERVE_RECEIVING','DEPARTURE','CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION','CANCEL_DEPARTURE') THEN
  PERFORM revoke_future_ownership(h.container_id,'Исходный receiving завершён, отменён или заменён; будущая передача прекращена');
 END IF;
 IF h.operation_type IN ('OWNER_CHANGE','DEPARTURE') THEN
  SELECT op.* INTO p FROM container_period op JOIN container_owner_history sh ON sh.id=op.start_container_owner_history_id
  WHERE op.container_visit_id=v.id AND sh.occurred_at<=h.occurred_at
  ORDER BY sh.occurred_at DESC,sh.created_at DESC,sh.id DESC LIMIT 1;
 END IF;
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
  INSERT INTO container_period(id,container_visit_id,client_id,start_container_owner_history_id)
   VALUES(gen_random_uuid(),v.id,h.new_client_id,h.id);
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR v.receiving_date IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL
   OR v.receiving_date>(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date OR v.receiving_date>billing_today() THEN
   RAISE EXCEPTION 'КТК должен находиться в остатках, дата передачи не раньше receiving текущего визита' USING ERRCODE='23514';
  END IF;
  IF p.client_id IS DISTINCT FROM h.old_client_id THEN RAISE EXCEPTION 'Прежний собственник не соответствует дате передачи' USING ERRCODE='23514'; END IF;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
  INSERT INTO container_period(id,container_visit_id,client_id,start_container_owner_history_id)
   VALUES(gen_random_uuid(),v.id,h.new_client_id,h.id);
 ELSIF h.operation_type='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shipping_order_container WHERE shipping_order_id=h.order_id
                 AND container_id=h.container_id AND status='FINISHED') THEN
   RAISE EXCEPTION 'Shipping requires a finished container row' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_container_owner_history_id=h.id WHERE id=v.id;
 ELSIF h.operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
  IF h.operation_type='CANCEL_ARRIVAL' THEN
   IF v.id IS NULL OR v.receiving_order_id<>h.order_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM container_owner WHERE container_id=h.container_id AND receiving_order_id=h.order_id) OR v.id IS NOT NULL
    THEN RAISE EXCEPTION 'Wrong receiving reservation cancellation' USING ERRCODE='23514'; END IF;
  END IF;
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
 END IF;
END $function$;

CREATE OR REPLACE FUNCTION refresh_container_owner_clients(container_ids uuid[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE today date:=billing_today(); cutoff timestamptz:=(today+1)::timestamp AT TIME ZONE 'Europe/Moscow';
        locked_ids uuid[]; plan record; previous_owner uuid; warehouse_status text; event_id uuid;
BEGIN
    SELECT array_agg(id) INTO locked_ids FROM (
        SELECT c.id FROM container c WHERE (container_ids IS NULL OR c.id=ANY(container_ids)) AND (
            EXISTS (SELECT 1 FROM service_order_container sc WHERE sc.container_id=c.id AND sc.result_status='PLANNED' AND sc.plan_at<cutoff)
            OR EXISTS (SELECT 1 FROM container_owner o JOIN container_owner_effective e USING (id)
                       WHERE o.container_id=c.id AND e.client_id IS NOT NULL AND o.client_id<>e.client_id))
        ORDER BY c.id FOR UPDATE OF c
    ) locked;
    IF locked_ids IS NULL THEN RETURN 0; END IF;

    FOR plan IN SELECT sc.* FROM service_order_container sc
        WHERE sc.container_id=ANY(locked_ids) AND sc.plan_at<cutoff AND sc.result_status='PLANNED'
        ORDER BY sc.container_id,sc.plan_at,sc.created_at,sc.id FOR UPDATE OF sc
    LOOP
        SELECT p.client_id INTO STRICT previous_owner FROM container_period p
        JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
        WHERE p.container_visit_id=plan.container_visit_id AND h.occurred_at<=plan.plan_at
        ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
        IF previous_owner=plan.plan_client_id THEN
            UPDATE service_order_container SET result_status='SKIPPED',withdrawn_at=billing_now(),
                result_reason='Собственник на дату передачи уже совпадает' WHERE id=plan.id;
            CONTINUE;
        END IF;
        SELECT h.new_status INTO STRICT warehouse_status FROM container_owner_history h
        WHERE h.container_id=plan.container_id AND h.order_type<>'SERVICE_ORDER' AND h.occurred_at<=plan.plan_at
        ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
        INSERT INTO container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at)
        VALUES(gen_random_uuid(),plan.container_id,previous_owner,plan.plan_client_id,warehouse_status,warehouse_status,
               plan.service_order_id,'SERVICE_ORDER',plan.plan_at) RETURNING id INTO event_id;
        PERFORM apply_container_history(event_id);
        UPDATE service_order_container sc SET container_period_id=p.id, result_status='APPLIED'
        FROM container_period p WHERE p.start_container_owner_history_id=event_id AND sc.id=plan.id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing period for ownership event %',event_id USING ERRCODE='23514'; END IF;
    END LOOP;
    RETURN refresh_owner_snapshot(locked_ids);
END $$;

CREATE OR REPLACE FUNCTION check_period_origin(period_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE fact record;
BEGIN
    SELECT p.id,p.container_visit_id,p.client_id,v.container_id,v.receiving_container_owner_history_id,
           h.id AS event_id,h.order_id,h.operation_type,h.container_id AS event_container,h.new_client_id INTO STRICT fact
    FROM container_period p JOIN container_visit v ON v.id=p.container_visit_id
    JOIN container_owner_history_view h ON h.id=p.start_container_owner_history_id WHERE p.id=period_id;
    IF (fact.client_id,fact.container_id) IS DISTINCT FROM (fact.new_client_id,fact.event_container)
       OR fact.operation_type NOT IN ('ARRIVAL','OWNER_CHANGE')
       OR (fact.operation_type='ARRIVAL' AND fact.event_id<>fact.receiving_container_owner_history_id)
       OR (fact.operation_type='OWNER_CHANGE' AND NOT EXISTS (
           SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
           WHERE sc.container_period_id=fact.id AND sc.container_id=fact.container_id
             AND sc.container_visit_id=fact.container_visit_id AND s.id=fact.order_id AND s.client_id=fact.client_id))
    THEN RAISE EXCEPTION 'Invalid event, owner, visit or document row for period %',period_id USING ERRCODE='23514';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION protect_storage_boundary_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.container_id,NEW.order_id,NEW.order_type,NEW.occurred_at,NEW.created_at,
        NEW.new_client_id,NEW.old_client_id,NEW.new_status,NEW.old_status) IS DISTINCT FROM
       (OLD.container_id,OLD.order_id,OLD.order_type,OLD.occurred_at,OLD.created_at,
        OLD.new_client_id,OLD.old_client_id,OLD.new_status,OLD.old_status)
       AND EXISTS (SELECT 1 FROM container_storage_period WHERE start_history_id=OLD.id OR end_history_id=OLD.id) THEN
        RAISE EXCEPTION 'Invalid storage boundary event mutation for %',OLD.id USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE container_owner_history DROP COLUMN container_period_id;
COMMENT ON COLUMN container_owner_history_view.container_period_id IS
    'Вычисляемый период для перехода из истории, с учётом порядка записи и времени действия событий.';
