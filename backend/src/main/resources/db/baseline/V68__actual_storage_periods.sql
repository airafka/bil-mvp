-- Preserve the physical relation, its primary key and incoming foreign keys.
-- Flyway runs all checks, the conversion and the new constraints in one transaction.
CREATE TEMP TABLE old_storage_facts ON COMMIT DROP AS
SELECT p.id, p.container_visit_id, p.client_id, sp.start_history_id, sp.end_history_id, sp.status
FROM container_period p JOIN container_storage_period sp USING (id);

DO $$
DECLARE mismatch record;
BEGIN
    SELECT p.id, p.record_type, p.start_container_owner_history_id AS event_id,
           h.operation_type, p.container_visit_id AS visit_id INTO mismatch
    FROM container_period p
    LEFT JOIN old_storage_facts f USING (id)
    LEFT JOIN container_visit_facts v ON v.id=p.container_visit_id
    LEFT JOIN container_owner_history_view h ON h.id=p.start_container_owner_history_id
    WHERE p.start_container_owner_history_id IS NOT NULL AND (
        f.id IS NULL OR v.id IS NULL OR h.operation_type NOT IN ('ARRIVAL','OWNER_CHANGE')
        OR (h.container_id,h.new_client_id,h.container_period_id) IS DISTINCT FROM (v.container_id,p.client_id,p.id)
        OR p.container_id<>v.container_id OR p.is_cancelled<>v.is_cancelled
        OR p.cancellation_container_owner_history_id IS DISTINCT FROM v.cancellation_container_owner_history_id
        OR p.effective_date IS DISTINCT FROM (h.occurred_at AT TIME ZONE 'Europe/Moscow')::date
        OR (h.operation_type='ARRIVAL' AND h.id<>v.receiving_container_owner_history_id)
        OR (h.operation_type='OWNER_CHANGE' AND NOT EXISTS (
            SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
            WHERE sc.service_order_id=h.order_id AND sc.container_id=h.container_id
              AND sc.container_visit_id=v.id AND sc.container_period_id=p.id AND s.client_id=p.client_id))
    ) ORDER BY p.id LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V68: cannot preserve this assignment as a factual storage period: %',row_to_json(mismatch); END IF;

    SELECT p.id,p.plan_order_id,p.container_visit_id,p.plan_at,p.is_withdrawn,sc.id AS order_row
    INTO mismatch FROM container_period p
    LEFT JOIN service_order_container sc ON sc.container_period_id=p.id
    LEFT JOIN service_order s ON s.id=p.plan_order_id
    LEFT JOIN container_visit v ON v.id=p.container_visit_id
    WHERE p.start_container_owner_history_id IS NULL AND (
        p.record_type<>'STORAGE' OR s.id IS NULL OR p.plan_at IS NULL OR v.container_id IS DISTINCT FROM p.container_id
        OR (sc.id IS NOT NULL AND (sc.service_order_id,sc.container_id,sc.container_visit_id) IS DISTINCT FROM
                                   (s.id,p.container_id,v.id))
        OR (NOT (p.is_withdrawn OR p.is_cancelled) AND (sc.id IS NULL OR sc.result_status<>'CONFIRMED'
            OR s.status<>'CONFIRMED' OR p.client_id<>s.client_id OR p.effective_date<>s.effective_date
            OR v.cancellation_container_owner_history_id IS NOT NULL OR v.shipping_container_owner_history_id IS NOT NULL))
        OR EXISTS (SELECT 1 FROM container_owner_history h WHERE h.container_period_id=p.id)
    ) ORDER BY p.id LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V68: ambiguous scheduled or withdrawn assignment: %',row_to_json(mismatch); END IF;

    SELECT sc.id,sc.result_status,sc.container_period_id,h.order_id,h.container_id INTO mismatch
    FROM service_order_container sc LEFT JOIN container_period p ON p.id=sc.container_period_id
    LEFT JOIN container_owner_history_view h ON h.id=p.start_container_owner_history_id
    WHERE (sc.result_status IN ('PLANNED','BLOCKED','APPLIED','CONFIRMED') AND p.id IS NULL)
       OR (h.id IS NOT NULL AND (h.order_type,h.order_id,h.container_id,p.container_visit_id)
            IS DISTINCT FROM ('SERVICE_ORDER',sc.service_order_id,sc.container_id,sc.container_visit_id))
    LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V68: unresolved document row: %',row_to_json(mismatch); END IF;
END $$;

ALTER TABLE service_order_container
    ADD COLUMN plan_at timestamptz,
    ADD COLUMN plan_client_id uuid REFERENCES client(id),
    ADD COLUMN withdrawn_at timestamptz,
    DROP CONSTRAINT service_order_container_service_order_id_container_id_key,
    DROP CONSTRAINT service_order_container_result_status_check;
CREATE UNIQUE INDEX service_order_container_selection ON service_order_container(service_order_id,container_id)
    WHERE result_status<>'WITHDRAWN';
CREATE UNIQUE INDEX service_order_container_fact ON service_order_container(container_period_id)
    WHERE container_period_id IS NOT NULL;

-- A detached, withdrawn attempt may predate the current composition or target of its draft.
INSERT INTO service_order_container(id,service_order_id,container_id,container_visit_id,
                                   plan_at,plan_client_id,withdrawn_at,result_reason,result_status,created_at)
SELECT p.id,p.plan_order_id,p.container_id,p.container_visit_id,p.plan_at,p.client_id,
       coalesce(p.withdrawn_at,p.updated_at),p.withdrawal_reason,'WITHDRAWN',p.created_at AT TIME ZONE 'UTC'
FROM container_period p WHERE p.start_container_owner_history_id IS NULL AND (p.is_withdrawn OR p.is_cancelled)
AND NOT EXISTS (SELECT 1 FROM service_order_container sc WHERE sc.container_period_id=p.id);

UPDATE service_order_container sc
SET plan_at=coalesce(p.plan_at,h.occurred_at),plan_client_id=p.client_id,
    withdrawn_at=p.withdrawn_at,result_reason=coalesce(sc.result_reason,p.withdrawal_reason),
    result_status=CASE WHEN h.id IS NOT NULL THEN 'APPLIED'
                       WHEN p.is_withdrawn OR p.is_cancelled THEN
                         CASE WHEN sc.result_status='SKIPPED' THEN 'SKIPPED' ELSE 'CANCELLED' END
                       ELSE 'PLANNED' END,
    container_period_id=CASE WHEN h.id IS NOT NULL THEN p.id END
FROM container_period p LEFT JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
WHERE sc.container_period_id=p.id;

ALTER TABLE service_order_container
    ADD CONSTRAINT service_order_container_result_status_check CHECK
      (result_status IN ('DRAFT','PLANNED','APPLIED','WITHDRAWN','SKIPPED','CANCELLED')),
    ADD CONSTRAINT ownership_row_fact CHECK ((result_status='APPLIED')=(container_period_id IS NOT NULL)),
    ADD CONSTRAINT ownership_row_plan CHECK (result_status NOT IN ('PLANNED','APPLIED','WITHDRAWN') OR
      (container_visit_id IS NOT NULL AND plan_at IS NOT NULL AND plan_client_id IS NOT NULL)),
    ADD CONSTRAINT ownership_row_visit FOREIGN KEY (container_visit_id,container_id) REFERENCES container_visit(id,container_id);
CREATE INDEX ownership_plans_by_time ON service_order_container(plan_at,container_id) WHERE result_status='PLANNED';

DROP TRIGGER ownership_period_visit_integrity ON container_period;
DROP TRIGGER ownership_period_origin_immutable ON container_period;
DROP TRIGGER ownership_period_boundary_events ON container_period; -- The visit trigger already checks all boundaries.
DROP TRIGGER ownership_period_stock_integrity ON container_period; -- Changes to the visit/register check physical stock.
DROP TRIGGER ownership_effective_date ON container_period;
DROP FUNCTION set_ownership_effective_date();
DROP FUNCTION withdraw_ownership_period(uuid,text);
DROP FUNCTION confirm_ownership_assignment(uuid,uuid,uuid,uuid,uuid,text,timestamptz);

CREATE OR REPLACE VIEW container_storage_period AS
WITH boundaries AS (
    SELECT p.id,v.container_id,h.id AS start_history_id,
           coalesce(lead(h.id) OVER (PARTITION BY v.id ORDER BY h.occurred_at,h.created_at,h.id),
                    v.shipping_container_owner_history_id) AS end_history_id,
           v.cancellation_container_owner_history_id AS cancellation_id,h.created_at AT TIME ZONE 'UTC' AS recorded_at
    FROM container_period p JOIN container_visit v ON v.id=p.container_visit_id
    JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
)
SELECT b.id,b.container_id,b.start_history_id,b.end_history_id,
       (CASE WHEN cancellation_id IS NOT NULL THEN 'CANCELLED' WHEN end_history_id IS NULL THEN 'OPEN' ELSE 'CLOSED' END)::varchar(20) AS status,
       b.recorded_at AS created_at,
       greatest(b.recorded_at,e.created_at AT TIME ZONE 'UTC',c.created_at AT TIME ZONE 'UTC') AS updated_at
FROM boundaries b LEFT JOIN container_owner_history e ON e.id=b.end_history_id
LEFT JOIN container_owner_history c ON c.id=b.cancellation_id;

CREATE OR REPLACE VIEW service_order_container_current AS
SELECT sc.id,sc.service_order_id,sc.container_id,sc.container_visit_id,sc.expected_client_id,sc.expected_status,
       (CASE WHEN sc.result_status='APPLIED' AND v.cancellation_container_owner_history_id IS NOT NULL THEN 'CANCELLED'
             WHEN sc.result_status='APPLIED' AND (sc.plan_at AT TIME ZONE 'Europe/Moscow')::date>billing_today() THEN 'PLANNED'
             ELSE sc.result_status END)::varchar(20) AS result_status,
       sc.result_reason,sc.container_period_id
FROM service_order_container sc LEFT JOIN container_visit v ON v.id=sc.container_visit_id
WHERE sc.result_status<>'WITHDRAWN';

-- Register ownership comes from actual events (including reservation and restoration).
CREATE OR REPLACE VIEW container_owner_effective AS
SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
       o.container_visit_id,o.version,o.receiving_order_id,owner.client_id
FROM container_owner_current o LEFT JOIN LATERAL (
    SELECT h.new_client_id AS client_id FROM container_owner_history_view h
    LEFT JOIN container_period p ON p.start_container_owner_history_id=h.id
    LEFT JOIN container_visit v ON v.id=p.container_visit_id
    WHERE h.container_id=o.container_id AND (h.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today()
      AND ((p.id IS NOT NULL AND v.cancellation_container_owner_history_id IS NULL)
        OR (h.operation_type='RESERVE_RECEIVING' AND o.status='EXPECTED' AND h.order_id=o.receiving_order_id)
        OR h.operation_type IN ('CANCEL_RECEIVING_RESERVATION','CANCEL_ARRIVAL'))
    ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1
) owner ON true;

DROP VIEW ownership_assignment_timeline;
DELETE FROM container_period WHERE start_container_owner_history_id IS NULL;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE container_period
    ALTER COLUMN container_visit_id SET NOT NULL, ALTER COLUMN start_container_owner_history_id SET NOT NULL,
    ADD CONSTRAINT container_period_visit_fk FOREIGN KEY (container_visit_id) REFERENCES container_visit(id),
    DROP COLUMN container_id, DROP COLUMN record_type, DROP COLUMN start_date, DROP COLUMN is_cancelled,
    DROP COLUMN cancellation_container_owner_history_id, DROP COLUMN created_at, DROP COLUMN updated_at,
    DROP COLUMN effective_date, DROP COLUMN is_withdrawn, DROP COLUMN withdrawn_at,
    DROP COLUMN withdrawal_reason, DROP COLUMN plan_order_id, DROP COLUMN plan_at;
CREATE INDEX container_period_by_visit ON container_period(container_visit_id);

-- Eligibility includes confirmed future plans so a chain can be entered in advance.
CREATE VIEW ownership_assignment_timeline AS
SELECT p.id,v.container_id,p.container_visit_id,p.client_id,h.occurred_at AS action_at,
       h.created_at AS recorded_at,h.id AS ordering_id,(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS effective_date
FROM container_period p JOIN container_visit v ON v.id=p.container_visit_id
JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
WHERE v.cancellation_container_owner_history_id IS NULL
UNION ALL
SELECT sc.id,sc.container_id,sc.container_visit_id,sc.plan_client_id,sc.plan_at,sc.created_at,sc.id,
       (sc.plan_at AT TIME ZONE 'Europe/Moscow')::date
FROM service_order_container sc WHERE sc.result_status='PLANNED';

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
    LEFT JOIN receiving_order_container auto_row ON auto_row.id=v.receiving_order_container_id
    LEFT JOIN waybill_container rail_row ON rail_row.id=v.waybill_container_id
    LEFT JOIN service_order own ON own.id = own_order
    JOIN LATERAL (
        SELECT op.client_id, op.effective_date, op.action_at AS occurred_at
        FROM ownership_assignment_timeline op
        WHERE op.container_visit_id = v.id
          AND op.effective_date <= transfer_date
        ORDER BY op.effective_date DESC, op.action_at DESC, op.recorded_at DESC, op.ordering_id DESC
        LIMIT 1
    ) p ON true
    WHERE (auto_row.status='FINISHED' OR rail_row.status='FINISHED') AND o.status = 'ON_TERMINAL' AND NOT v.is_cancelled AND v.shipping_date IS NULL
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
 row_id uuid; rail_id uuid; count_rows integer; result_id uuid; previous_receiving uuid; latest timestamptz;
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
  row_id:=NULL;rail_id:=NULL;
  IF (SELECT transport_type FROM receiving_order WHERE id=h.order_id)='VEHICLE' THEN
   SELECT count(*),(array_agg(id) FILTER (WHERE status='FINISHED'))[1] INTO count_rows,row_id FROM receiving_order_container WHERE receiving_order_id=h.order_id AND container_id=h.container_id;
  ELSE
   SELECT count(*),(array_agg(wc.id) FILTER (WHERE wc.status='FINISHED'))[1] INTO count_rows,rail_id FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
    JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=h.order_id AND wc.container_id=h.container_id;
  END IF;
  IF count_rows<>1 OR coalesce(row_id,rail_id) IS NULL THEN RAISE EXCEPTION 'Receiving requires exactly one finished container row' USING ERRCODE='23514'; END IF;
  v.id:=gen_random_uuid();
  INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id,receiving_container_owner_history_id)
   VALUES(v.id,h.container_id,h.order_id,row_id,rail_id,h.id);
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
  SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM shipping_order_container WHERE shipping_order_id=h.order_id AND container_id=h.container_id AND status='FINISHED';
  IF count_rows<>1 THEN RAISE EXCEPTION 'Shipping requires exactly one finished row' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_order_container_id=row_id,
   shipping_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  result_id:=p.id;
 ELSIF h.operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
  IF h.operation_type='CANCEL_ARRIVAL' THEN
   IF v.id IS NULL OR v.receiving_order_id<>h.order_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM container_owner WHERE container_id=h.container_id AND receiving_order_id=h.order_id) OR v.id IS NOT NULL
    THEN RAISE EXCEPTION 'Wrong receiving reservation cancellation' USING ERRCODE='23514'; END IF;
  END IF;
  result_id:=p.id;
  UPDATE container_visit SET cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  previous_receiving:=previous_stock_order(h.container_id,h.order_id,'RECEIVING_ORDER');
  UPDATE container_owner SET receiving_order_id=previous_receiving,
   shipping_order_id=(SELECT sc.shipping_order_id FROM container_visit cv JOIN shipping_order_container sc ON sc.id=cv.shipping_order_container_id WHERE cv.container_id=h.container_id AND cv.receiving_order_id=previous_receiving)
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
  UPDATE container_visit SET shipping_order_container_id=NULL,shipping_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=v.id;
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
 IF v.is_cancelled THEN
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

CREATE CONSTRAINT TRIGGER ownership_period_visit_integrity AFTER INSERT OR UPDATE OR DELETE ON container_period
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_visit();

CREATE OR REPLACE FUNCTION require_physical_ownership_visit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM container_visit WHERE id=NEW.container_visit_id
        AND cancellation_container_owner_history_id IS NULL AND shipping_container_owner_history_id IS NULL) THEN
        RAISE EXCEPTION 'Storage requires an open physical visit: %',NEW.container_visit_id USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_ownership_period_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'A factual storage period is immutable: %',OLD.id USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ownership_period_origin_immutable BEFORE UPDATE OR DELETE ON container_period
FOR EACH ROW EXECUTE FUNCTION protect_ownership_period_start();

CREATE FUNCTION check_period_origin(period_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE fact record;
BEGIN
    SELECT p.id,p.container_visit_id,p.client_id,v.container_id,v.receiving_container_owner_history_id,
           h.id AS event_id,h.order_id,h.operation_type,h.container_id AS event_container,h.new_client_id,
           h.container_period_id AS backlink INTO STRICT fact
    FROM container_period p JOIN container_visit v ON v.id=p.container_visit_id
    JOIN container_owner_history_view h ON h.id=p.start_container_owner_history_id WHERE p.id=period_id;
    IF (fact.client_id,fact.container_id,fact.id) IS DISTINCT FROM (fact.new_client_id,fact.event_container,fact.backlink)
       OR fact.operation_type NOT IN ('ARRIVAL','OWNER_CHANGE')
       OR (fact.operation_type='ARRIVAL' AND fact.event_id<>fact.receiving_container_owner_history_id)
       OR (fact.operation_type='OWNER_CHANGE' AND NOT EXISTS (
           SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
           WHERE sc.container_period_id=fact.id AND sc.container_id=fact.container_id
             AND sc.container_visit_id=fact.container_visit_id AND s.id=fact.order_id AND s.client_id=fact.client_id))
    THEN RAISE EXCEPTION 'Invalid event, owner, visit or document row for period %',period_id USING ERRCODE='23514';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_ownership_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM check_period_origin(NEW.id);
    RETURN NULL;
END $$;

CREATE FUNCTION check_ownership_order_row(row_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
    SELECT sc.*,s.status AS order_status,s.client_id AS target,s.effective_date AS day,
           h.occurred_at AS actual_at,h.order_id AS actual_order INTO r
    FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
    LEFT JOIN container_period p ON p.id=sc.container_period_id
    LEFT JOIN container_owner_history h ON h.id=p.start_container_owner_history_id WHERE sc.id=row_id;
    IF NOT FOUND OR r.result_status NOT IN ('PLANNED','APPLIED') THEN RETURN; END IF;
    IF r.order_status<>'CONFIRMED' OR r.target<>r.plan_client_id OR r.day IS DISTINCT FROM (r.plan_at AT TIME ZONE 'Europe/Moscow')::date
       OR (r.result_status='APPLIED' AND (r.actual_at,r.actual_order) IS DISTINCT FROM (r.plan_at,r.service_order_id))
    THEN RAISE EXCEPTION 'Ownership row % does not match its order or event',row_id USING ERRCODE='23514'; END IF;
    IF r.container_period_id IS NOT NULL THEN PERFORM check_period_origin(r.container_period_id); END IF;
END $$;

CREATE FUNCTION validate_ownership_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_id uuid;
BEGIN
    IF TG_TABLE_NAME='service_order' THEN
        FOR row_id IN SELECT id FROM service_order_container WHERE service_order_id=NEW.id LOOP
            PERFORM check_ownership_order_row(row_id);
        END LOOP;
    ELSE
        IF TG_OP<>'INSERT' AND OLD.container_period_id IS NOT NULL THEN PERFORM check_period_origin(OLD.container_period_id); END IF;
        IF TG_OP<>'DELETE' THEN PERFORM check_ownership_order_row(NEW.id); END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ownership_order_row_integrity AFTER INSERT OR UPDATE OR DELETE ON service_order_container
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ownership_document();
CREATE CONSTRAINT TRIGGER ownership_order_integrity AFTER UPDATE ON service_order
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ownership_document();

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
        UPDATE service_order_container sc SET container_period_id=h.container_period_id,result_status='APPLIED'
        FROM container_owner_history h WHERE h.id=event_id AND sc.id=plan.id;
    END LOOP;
    RETURN refresh_owner_snapshot(locked_ids);
END $$;

CREATE OR REPLACE FUNCTION revoke_future_ownership(physical_container uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE service_order_container SET result_status='SKIPPED',withdrawn_at=billing_now(),result_reason=reason
    WHERE container_id=physical_container AND result_status='PLANNED'
      AND plan_at>=(billing_today()+1)::timestamp AT TIME ZONE 'Europe/Moscow';
END $$;

CREATE FUNCTION withdraw_ownership_order(doc uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sc record;
BEGIN
    FOR sc IN SELECT * FROM service_order_container WHERE service_order_id=doc AND result_status<>'WITHDRAWN'
              ORDER BY container_id FOR UPDATE LOOP
        IF sc.container_period_id IS NOT NULL OR (sc.plan_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today() THEN
            RAISE EXCEPTION 'Нельзя отозвать фактическую передачу или передачу с наступившей датой' USING ERRCODE='23514';
        END IF;
        IF sc.result_status='PLANNED' AND EXISTS (
            SELECT 1 FROM ownership_assignment_timeline n WHERE n.container_id=sc.container_id AND n.action_at>sc.plan_at
        ) THEN RAISE EXCEPTION 'Сначала отмените последующие операции КТК' USING ERRCODE='23514'; END IF;
        -- Keep the confirmed attempt and give the editable draft a separate row.
        UPDATE service_order_container SET result_status='WITHDRAWN',withdrawn_at=coalesce(withdrawn_at,billing_now()),
            result_reason=coalesce(result_reason,'Заявка возвращена в черновик') WHERE id=sc.id;
        INSERT INTO service_order_container(id,service_order_id,container_id) VALUES(gen_random_uuid(),doc,sc.container_id);
    END LOOP;
END $$;

COMMENT ON TABLE container_period IS 'Фактическое начало хранения у собственника в конкретном заезде КТК.';
COMMENT ON COLUMN container_period.container_visit_id IS 'Заезд КТК от фактической приёмки до вывоза.';
COMMENT ON COLUMN container_period.start_container_owner_history_id IS 'Единственное начальное событие ARRIVAL или OWNER_CHANGE. Рабочая дата и время находятся в occurred_at.';
COMMENT ON COLUMN service_order_container.plan_at IS 'Момент действия передачи с учётом порядка операций одного дня.';
COMMENT ON COLUMN service_order_container.plan_client_id IS 'Снимок нового собственника из шапки при подтверждении. Сохраняется при отзыве и редактировании черновика.';
COMMENT ON COLUMN service_order_container.container_period_id IS 'Фактический период, открытый по этой строке заявки.';

DO $$
DECLARE mismatch record;
BEGIN
    SELECT coalesce(f.id,p.id) AS period_id,f.start_history_id AS old_start,sp.start_history_id AS new_start,
           f.end_history_id AS old_end,sp.end_history_id AS new_end,f.status AS old_status,sp.status AS new_status
    INTO mismatch FROM old_storage_facts f FULL JOIN container_period p USING (id)
    LEFT JOIN container_storage_period sp ON sp.id=p.id
    WHERE (f.id,f.container_visit_id,f.client_id,f.start_history_id,f.end_history_id,f.status) IS DISTINCT FROM
          (p.id,p.container_visit_id,p.client_id,sp.start_history_id,sp.end_history_id,sp.status) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'V68: storage boundaries changed: %',row_to_json(mismatch); END IF;
    PERFORM check_period_origin(id) FROM container_period;
    PERFORM check_container_visit(id) FROM container_visit;
    PERFORM check_ownership_order_row(id) FROM service_order_container;
END $$;
