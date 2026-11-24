LOCK TABLE service_order,service_order_container,container_period,container_owner_history,outbound_data IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE service_order ADD COLUMN is_deferred boolean NOT NULL DEFAULT false,
    DROP CONSTRAINT service_order_status_check,
    ADD CONSTRAINT service_order_status_check CHECK(status IN ('DRAFT','SCHEDULED','DONE','CANCELLED'));
UPDATE service_order SET is_deferred=true WHERE status='SCHEDULED'
    OR (status='DRAFT' AND effective_date>billing_today())
    OR (status='DONE' AND effective_date>(completion_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date);
CREATE OR REPLACE VIEW service_order_current AS
SELECT id,number,client_id,service,comment,status::varchar(20),completion_at,created_at,created_by,
       updated_at,updated_by,effective_date,source_client_id,execution_error,is_deferred FROM service_order;

ALTER TABLE outbound_data ADD COLUMN ready_at timestamptz;
UPDATE outbound_data SET ready_at=created_at AT TIME ZONE 'UTC';
COMMENT ON COLUMN outbound_data.ready_at IS 'Разрешение на отправку после обновления остатка. NULL у будущей передачи.';

ALTER TABLE container_period ADD COLUMN effective_at timestamptz, ADD COLUMN service_order_id uuid REFERENCES service_order(id);
ALTER TABLE container_period DISABLE TRIGGER ownership_period_origin_immutable;
UPDATE container_period p SET effective_at=h.occurred_at,
    service_order_id=CASE WHEN h.order_type='SERVICE_ORDER' THEN h.order_id END
FROM container_owner_history h WHERE h.id=p.start_container_owner_history_id;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE container_period ENABLE TRIGGER ownership_period_origin_immutable;
ALTER TABLE container_period ALTER COLUMN effective_at SET NOT NULL;
SET CONSTRAINTS ALL DEFERRED;
CREATE INDEX container_period_visit_effective ON container_period(container_visit_id,effective_at);
COMMENT ON COLUMN container_period.effective_at IS 'Начало владения в этом заезде, включая подтверждённые будущие назначения.';
COMMENT ON COLUMN container_period.service_order_id IS 'Заявка на смену собственника. Для первоначального периода приёмки поле пустое.';

CREATE FUNCTION set_container_period_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT occurred_at,CASE WHEN order_type='SERVICE_ORDER' THEN order_id END
    INTO STRICT NEW.effective_at,NEW.service_order_id FROM container_owner_history WHERE id=NEW.start_container_owner_history_id;
    RETURN NEW;
END $$;
CREATE TRIGGER container_period_origin BEFORE INSERT ON container_period FOR EACH ROW EXECUTE FUNCTION set_container_period_origin();

-- Dated periods remain visible in the physical table after cancellation, for audit.
CREATE VIEW active_container_period AS
SELECT p.* FROM container_period p LEFT JOIN service_order s ON s.id=p.service_order_id
WHERE s.status IS DISTINCT FROM 'CANCELLED';
CREATE OR REPLACE VIEW ownership_assignment_timeline AS
SELECT p.id,v.container_id,p.container_visit_id,p.client_id,p.effective_at AS action_at,
       h.created_at AS recorded_at,h.id AS ordering_id,(p.effective_at AT TIME ZONE 'Europe/Moscow')::date AS effective_date
FROM active_container_period p JOIN container_visit v ON v.id=p.container_visit_id
JOIN container_owner_history h ON h.id=p.start_container_owner_history_id WHERE v.cancellation_container_owner_history_id IS NULL;

ALTER TABLE service_order_container DROP CONSTRAINT ownership_row_fact;
ALTER TABLE service_order_container ADD CONSTRAINT ownership_row_fact CHECK (
    (container_period_id IS NULL OR result_status IN ('PLANNED','APPLIED','CANCELLED')) AND
    (result_status<>'APPLIED' OR container_period_id IS NOT NULL));

CREATE OR REPLACE FUNCTION check_actual_transfer_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM service_order s JOIN service_order_container sc ON sc.service_order_id=s.id
        WHERE s.id=NEW.order_id AND s.status='SCHEDULED' AND sc.container_id=NEW.container_id
        AND sc.result_status='PLANNED' AND sc.plan_at=NEW.occurred_at AND sc.plan_client_id=NEW.new_client_id)
    THEN RAISE EXCEPTION 'Событие передачи должно соответствовать подтверждённой строке заявки' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE VIEW container_storage_period AS
WITH boundaries AS (
    SELECT p.id,v.container_id,h.id AS start_history_id,
           coalesce(lead(h.id) OVER (PARTITION BY v.id ORDER BY h.occurred_at,h.created_at,h.id),
                    v.shipping_container_owner_history_id) AS end_history_id,
           v.cancellation_container_owner_history_id AS cancellation_id,h.created_at AT TIME ZONE 'UTC' AS recorded_at
    FROM active_container_period p JOIN container_visit v ON v.id=p.container_visit_id
    JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
)
SELECT b.id,b.container_id,b.start_history_id,b.end_history_id,
       (CASE WHEN cancellation_id IS NOT NULL THEN 'CANCELLED' WHEN end_history_id IS NULL THEN 'OPEN' ELSE 'CLOSED' END)::varchar(20) AS status,
       b.recorded_at AS created_at,
       greatest(b.recorded_at,e.created_at AT TIME ZONE 'UTC',c.created_at AT TIME ZONE 'UTC') AS updated_at
FROM boundaries b LEFT JOIN container_owner_history e ON e.id=b.end_history_id
LEFT JOIN container_owner_history c ON c.id=b.cancellation_id;

CREATE OR REPLACE FUNCTION protect_storage_boundary_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.container_id,NEW.order_id,NEW.order_type,NEW.occurred_at,NEW.created_at,
        NEW.new_client_id,NEW.old_client_id,NEW.new_status,NEW.old_status) IS DISTINCT FROM
       (OLD.container_id,OLD.order_id,OLD.order_type,OLD.occurred_at,OLD.created_at,
        OLD.new_client_id,OLD.old_client_id,OLD.new_status,OLD.old_status)
       AND (EXISTS (SELECT 1 FROM container_period WHERE start_container_owner_history_id=OLD.id)
            OR EXISTS (SELECT 1 FROM container_storage_period WHERE end_history_id=OLD.id)) THEN
        RAISE EXCEPTION 'Invalid storage boundary event mutation for %',OLD.id USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE VIEW container_owner_effective AS
SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
       o.container_visit_id,o.version,o.receiving_order_id,owner.client_id
FROM container_owner_current o LEFT JOIN LATERAL (
    SELECT h.new_client_id AS client_id FROM container_owner_history_view h
    LEFT JOIN container_period p ON p.start_container_owner_history_id=h.id
    LEFT JOIN container_visit v ON v.id=p.container_visit_id
    WHERE h.container_id=o.container_id AND (h.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today()
      AND (p.service_order_id IS NULL OR EXISTS (SELECT 1 FROM service_order s WHERE s.id=p.service_order_id AND s.status='DONE'))
      AND ((p.id IS NOT NULL AND v.cancellation_container_owner_history_id IS NULL)
        OR (h.operation_type='RESERVE_RECEIVING' AND o.status='EXPECTED' AND h.order_id=o.receiving_order_id)
        OR h.operation_type IN ('CANCEL_RECEIVING_RESERVATION','CANCEL_ARRIVAL'))
    ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1
) owner ON true;

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
               SELECT p.id FROM active_container_period p
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
  SELECT op.* INTO p FROM active_container_period op JOIN container_owner_history sh ON sh.id=op.start_container_owner_history_id
  WHERE op.container_visit_id=v.id AND sh.occurred_at<=h.occurred_at
  ORDER BY sh.occurred_at DESC,sh.created_at DESC,sh.id DESC LIMIT 1;
 END IF;
 IF h.operation_type IN ('DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT max(occurred_at) INTO latest FROM container_owner_history_view e WHERE e.container_id=h.container_id AND e.id<>h.id AND (e.order_type<>'SERVICE_ORDER' OR EXISTS (SELECT 1 FROM service_order s WHERE s.id=e.order_id AND s.status='DONE'));
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

CREATE OR REPLACE FUNCTION check_ownership_order_row(row_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
    SELECT sc.*,s.status AS order_status,s.client_id AS target,s.effective_date AS day,
           h.occurred_at AS actual_at,h.order_id AS actual_order INTO r
    FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
    LEFT JOIN container_period p ON p.id=sc.container_period_id
    LEFT JOIN container_owner_history h ON h.id=p.start_container_owner_history_id WHERE sc.id=row_id;
    IF NOT FOUND OR r.result_status NOT IN ('PLANNED','APPLIED') THEN RETURN; END IF;
    IF (r.order_status NOT IN ('SCHEDULED','DONE') OR (r.result_status='PLANNED' AND r.order_status<>'SCHEDULED')) OR r.target<>r.plan_client_id OR r.day IS DISTINCT FROM (r.plan_at AT TIME ZONE 'Europe/Moscow')::date
       OR (r.actual_at,r.actual_order) IS DISTINCT FROM (r.plan_at,r.service_order_id)
    THEN RAISE EXCEPTION 'Ownership row % does not match its order or event',row_id USING ERRCODE='23514'; END IF;
    IF r.container_period_id IS NOT NULL THEN PERFORM check_period_origin(r.container_period_id); END IF;
END $$;

CREATE FUNCTION record_ownership_order(doc uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; event_id uuid; period_id uuid; warehouse_status text;
BEGIN
    FOR r IN SELECT * FROM service_order_container WHERE service_order_id=doc AND result_status='PLANNED'
        AND container_period_id IS NULL ORDER BY container_id FOR UPDATE LOOP
        SELECT new_status INTO STRICT warehouse_status FROM container_owner_history
        WHERE container_id=r.container_id AND order_type<>'SERVICE_ORDER' AND occurred_at<=r.plan_at
        ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1;
        INSERT INTO container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,
            order_id,order_type,occurred_at)
        VALUES(gen_random_uuid(),r.container_id,r.expected_client_id,r.plan_client_id,warehouse_status,warehouse_status,
            doc,'SERVICE_ORDER',r.plan_at) RETURNING id INTO event_id;
        INSERT INTO container_period(id,container_visit_id,client_id,start_container_owner_history_id)
        VALUES(gen_random_uuid(),r.container_visit_id,r.plan_client_id,event_id) RETURNING id INTO period_id;
        UPDATE service_order_container SET container_period_id=period_id WHERE id=r.id;
    END LOOP;
    INSERT INTO outbound_data(entity_type,message_type,root_object_id)
    VALUES('SERVICE_ORDER','SERVICE_ORDER_CHAIN_PACKAGE',doc);
END $$;

CREATE OR REPLACE FUNCTION apply_ownership_order(doc uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE ids uuid[]; reason text;
BEGIN
    PERFORM 1 FROM service_order WHERE id=doc AND status='SCHEDULED' AND effective_date<=billing_today() FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT array_agg(id) INTO ids FROM (
        SELECT c.id FROM container c JOIN service_order_container sc ON sc.container_id=c.id
        WHERE sc.service_order_id=doc AND sc.result_status<>'WITHDRAWN' ORDER BY c.id FOR UPDATE OF c
    ) locked;
    SELECT CASE WHEN sc.result_status NOT IN ('PLANNED','APPLIED') OR sc.container_period_id IS NULL
                         OR o.status IS DISTINCT FROM 'ON_TERMINAL' OR sc.container_visit_id IS DISTINCT FROM o.container_visit_id
                THEN 'КТК '||c.code||' недоступен для передачи.'
                WHEN EXISTS (SELECT 1 FROM service_order_container earlier WHERE earlier.container_id=sc.container_id
                    AND earlier.result_status='PLANNED' AND earlier.plan_at<sc.plan_at)
                THEN 'По КТК '||c.code||' ожидает выполнения более ранняя передача.' END INTO reason
    FROM service_order_container sc JOIN container c ON c.id=sc.container_id
    LEFT JOIN container_owner_current o ON o.container_id=c.id
    WHERE sc.service_order_id=doc AND sc.result_status NOT IN ('WITHDRAWN','APPLIED')
    ORDER BY 1 NULLS LAST LIMIT 1;
    IF ids IS NULL THEN reason:='В заявке нет КТК для передачи.'; END IF;
    IF reason IS NOT NULL THEN
        UPDATE service_order SET execution_error=reason WHERE id=doc AND execution_error IS DISTINCT FROM reason;
        RETURN reason;
    END IF;
    UPDATE service_order_container SET result_status='APPLIED' WHERE service_order_id=doc AND result_status='PLANNED';
    UPDATE service_order SET status='DONE',execution_error=NULL,updated_at=billing_now() AT TIME ZONE 'UTC' WHERE id=doc;
    PERFORM refresh_owner_snapshot(ids);
    UPDATE outbound_data SET ready_at=clock_timestamp() WHERE root_object_id=doc AND entity_type='SERVICE_ORDER'
        AND message_type='SERVICE_ORDER_CHAIN_PACKAGE' AND ready_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Нет ожидающего исходящего сообщения для заявки %',doc; END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION cancel_ownership_order(doc uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE service_order SET status='CANCELLED',execution_error=NULL,updated_at=billing_now() AT TIME ZONE 'UTC',
        updated_by='local' WHERE id=doc AND status='SCHEDULED';
    IF NOT FOUND THEN RAISE EXCEPTION 'Отменить можно только подтверждённую заявку' USING ERRCODE='23514'; END IF;
    UPDATE service_order_container SET result_status='CANCELLED',withdrawn_at=billing_now(),result_reason=reason
        WHERE service_order_id=doc AND result_status IN ('PLANNED','SKIPPED');
    DELETE FROM outbound_data WHERE root_object_id=doc AND entity_type='SERVICE_ORDER'
        AND message_type='SERVICE_ORDER_CHAIN_PACKAGE' AND ready_at IS NULL AND success IS NULL;
END $$;

DROP FUNCTION withdraw_ownership_order(uuid);

CREATE OR REPLACE FUNCTION revoke_future_ownership(physical_container uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE doc uuid;
BEGIN
    IF EXISTS (SELECT 1 FROM service_order_container WHERE container_id=physical_container AND result_status='PLANNED'
        AND (plan_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today()) THEN
        RAISE EXCEPTION 'По КТК ожидает выполнения передача с наступившей датой' USING ERRCODE='23514';
    END IF;
    -- Losing a visit invalidates the whole document, including downstream assignments relying on it.
    FOR doc IN WITH RECURSIVE affected(id) AS (
        SELECT service_order_id FROM service_order_container WHERE container_id=physical_container AND result_status='PLANNED'
        UNION
        SELECT b.service_order_id FROM affected a JOIN service_order_container x ON x.service_order_id=a.id
        JOIN service_order_container b ON b.container_id=x.container_id AND b.plan_at>x.plan_at
        WHERE x.result_status='PLANNED' AND b.result_status='PLANNED'
    ) SELECT id FROM affected ORDER BY id LOOP
        PERFORM cancel_ownership_order(doc,reason);
    END LOOP;
END $$;

-- Import only pending assignments. Completed documents retain their event, period and delivery UUIDs.
DO $$
DECLARE doc record;
BEGIN
    FOR doc IN SELECT id FROM service_order WHERE status='SCHEDULED' ORDER BY effective_date,number LOOP
        IF EXISTS (SELECT 1 FROM service_order_container WHERE service_order_id=doc.id AND result_status='SKIPPED')
           AND NOT EXISTS (SELECT 1 FROM service_order_container WHERE service_order_id=doc.id AND result_status='APPLIED') THEN
            PERFORM cancel_ownership_order(doc.id,'Исходная передача была прекращена до обновления');
        ELSE
            PERFORM record_ownership_order(doc.id);
        END IF;
    END LOOP;
END $$;
