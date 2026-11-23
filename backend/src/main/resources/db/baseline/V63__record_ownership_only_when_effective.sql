-- A scheduled assignment belongs to its document and visit. Its event is linked
-- once, when the effective business date is reached.
ALTER TABLE container_ownership_period
    ADD COLUMN plan_order_id uuid REFERENCES service_order(id),
    ADD COLUMN plan_at timestamptz,
    ALTER COLUMN start_container_owner_history_id DROP NOT NULL;
CREATE TEMP TABLE old_plans ON COMMIT DROP AS
SELECT p.id, h.id AS event_id, h.order_id, h.occurred_at
FROM container_ownership_period p JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
WHERE h.order_type='SERVICE_ORDER' AND p.record_type='STORAGE'
  AND p.effective_date > (p.created_at AT TIME ZONE 'Europe/Moscow')::date
  AND ((p.is_withdrawn AND (p.withdrawn_at AT TIME ZONE 'Europe/Moscow')::date < p.effective_date)
    OR (NOT p.is_cancelled AND NOT p.is_withdrawn AND p.effective_date > billing_today()
        AND NOT EXISTS (SELECT 1 FROM container_owner_history later WHERE later.container_id=p.container_id
          AND later.order_type <> 'SERVICE_ORDER' AND later.occurred_at>=h.occurred_at)));

DROP TRIGGER ownership_period_origin_immutable ON container_ownership_period;
ALTER TABLE container_ownership_period ADD CONSTRAINT ownership_plan_origin CHECK (
 (plan_order_id IS NULL AND plan_at IS NULL AND start_container_owner_history_id IS NOT NULL)
 OR (plan_order_id IS NOT NULL AND plan_at IS NOT NULL AND record_type='STORAGE'
     AND effective_date=(plan_at AT TIME ZONE 'Europe/Moscow')::date));
CREATE INDEX ownership_plans_due ON container_ownership_period(effective_date,container_id)
 WHERE start_container_owner_history_id IS NULL AND NOT is_cancelled AND NOT is_withdrawn;

CREATE OR REPLACE FUNCTION set_ownership_effective_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.start_container_owner_history_id IS NULL THEN
    NEW.effective_date := (NEW.plan_at AT TIME ZONE 'Europe/Moscow')::date;
 ELSE
    SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date INTO STRICT NEW.effective_date
    FROM container_owner_history WHERE id=NEW.start_container_owner_history_id;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_ownership_period_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership assignments cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.container_id,NEW.container_visit_id,NEW.client_id,NEW.start_date,NEW.record_type,NEW.effective_date,NEW.plan_order_id,NEW.plan_at)
    IS DISTINCT FROM (OLD.container_id,OLD.container_visit_id,OLD.client_id,OLD.start_date,OLD.record_type,OLD.effective_date,OLD.plan_order_id,OLD.plan_at)
 OR (NEW.start_container_owner_history_id IS DISTINCT FROM OLD.start_container_owner_history_id AND
     (OLD.start_container_owner_history_id IS NOT NULL OR OLD.is_cancelled OR OLD.is_withdrawn OR OLD.effective_date>billing_today()))
 THEN RAISE EXCEPTION 'Ownership origin is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.is_withdrawn AND NOT NEW.is_withdrawn THEN RAISE EXCEPTION 'Cannot restore a withdrawn assignment' USING ERRCODE='23514'; END IF;
 IF NOT OLD.is_withdrawn AND NEW.is_withdrawn AND OLD.effective_date<=billing_today()
 AND (OLD.start_container_owner_history_id IS NOT NULL OR OLD.client_id IS DISTINCT FROM (
    SELECT a.client_id FROM ownership_assignment_timeline a
    WHERE a.container_visit_id=OLD.container_visit_id AND a.start_container_owner_history_id IS NOT NULL
      AND NOT a.is_cancelled AND NOT a.is_withdrawn AND a.action_at<=OLD.plan_at
    ORDER BY a.action_at DESC,a.recorded_at DESC,a.ordering_id DESC LIMIT 1))
 THEN RAISE EXCEPTION 'Cannot withdraw an effective assignment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_ownership_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p container_ownership_period%ROWTYPE; h container_owner_history_view%ROWTYPE;
BEGIN
 SELECT * INTO p FROM container_ownership_period WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p.start_container_owner_history_id IS NULL THEN
    IF NOT p.is_cancelled AND NOT p.is_withdrawn AND NOT EXISTS (
      SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
      WHERE sc.container_ownership_period_id=p.id AND sc.service_order_id=p.plan_order_id
      AND sc.container_id=p.container_id AND sc.container_visit_id=p.container_visit_id AND s.client_id=p.client_id
      AND s.effective_date=p.effective_date AND s.status='CONFIRMED')
    THEN RAISE EXCEPTION 'Scheduled assignment has no matching order' USING ERRCODE='23514'; END IF;
    RETURN NULL;
 END IF;
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=p.start_container_owner_history_id;
 IF p.container_id<>h.container_id OR p.client_id<>h.new_client_id
 OR (p.plan_order_id IS NOT NULL AND (h.order_id<>p.plan_order_id OR h.order_type<>'SERVICE_ORDER' OR h.occurred_at<>p.plan_at))
 OR (p.record_type='EXPECTED' AND h.new_status<>'EXPECTED') OR (p.record_type='OUTSIDE_STORAGE' AND h.new_status<>'DEPARTED')
 THEN RAISE EXCEPTION 'Ownership assignment does not match history' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE VIEW ownership_assignment_timeline AS
 SELECT p.*,coalesce(p.plan_at,h.occurred_at) AS action_at,coalesce(p.plan_order_id,h.order_id) AS origin_order_id,
        coalesce(h.created_at,p.created_at AT TIME ZONE 'UTC') AS recorded_at,coalesce(h.id,p.id) AS ordering_id
 FROM container_ownership_period p LEFT JOIN container_owner_history h ON h.id=p.start_container_owner_history_id;

CREATE OR REPLACE VIEW container_owner_effective AS
 SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,o.container_visit_id,o.version,
  coalesce(o.receiving_order_id,v.receiving_order_id) AS receiving_order_id,p.client_id
 FROM container_owner o LEFT JOIN container_visit v ON v.id=o.container_visit_id
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
    JOIN container_visit v ON v.id = o.container_visit_id
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


CREATE OR REPLACE FUNCTION withdraw_ownership_period(period_id uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p ownership_assignment_timeline%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM ownership_assignment_timeline WHERE id=period_id;
 IF p.is_withdrawn THEN RETURN; END IF;
 IF p.effective_date<=billing_today() THEN RAISE EXCEPTION 'Нельзя отозвать передачу с наступившей датой' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM container_visit WHERE id=p.container_visit_id AND shipping_date>=p.effective_date)
 OR EXISTS(SELECT 1 FROM ownership_assignment_timeline n WHERE n.container_id=p.container_id AND NOT n.is_withdrawn
    AND NOT n.is_cancelled AND (n.effective_date,n.action_at,n.recorded_at,n.ordering_id)>
                            (p.effective_date,p.action_at,p.recorded_at,p.ordering_id))
 THEN RAISE EXCEPTION 'Сначала отмените последующие операции КТК' USING ERRCODE='23514'; END IF;
 UPDATE container_ownership_period SET is_withdrawn=true,withdrawn_at=billing_now(),withdrawal_reason=reason,updated_at=billing_now() WHERE id=p.id;
END $$;
CREATE OR REPLACE FUNCTION revoke_future_ownership(physical_container uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
 FOR p IN SELECT t.id FROM ownership_assignment_timeline t JOIN service_order s ON s.id=t.origin_order_id
 WHERE t.container_id=physical_container AND t.effective_date>billing_today() AND NOT t.is_withdrawn AND NOT t.is_cancelled
 ORDER BY t.effective_date DESC,t.action_at DESC,t.id DESC LOOP
    PERFORM withdraw_ownership_period(p.id,reason);
    UPDATE service_order_container SET result_status='SKIPPED',result_reason=reason WHERE container_ownership_period_id=p.id;
 END LOOP;
END $$;

CREATE FUNCTION confirm_ownership_assignment(doc uuid,ktk uuid,visit uuid,previous_owner uuid,target uuid,stock_status text,effective_at timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE result uuid; event uuid; day date := (effective_at AT TIME ZONE 'Europe/Moscow')::date;
BEGIN
 IF day>billing_today() THEN
    INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,plan_order_id,plan_at)
    VALUES(gen_random_uuid(),ktk,visit,target,'STORAGE',day,doc,effective_at) RETURNING id INTO result;
 ELSE
    INSERT INTO container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at)
    VALUES(gen_random_uuid(),ktk,previous_owner,target,stock_status,stock_status,doc,'SERVICE_ORDER',effective_at) RETURNING id INTO event;
    PERFORM apply_container_history(event);
    SELECT storage_period_id INTO STRICT result FROM container_owner_history WHERE id=event;
    PERFORM refresh_container_owner_clients(ARRAY[ktk]);
 END IF;
 RETURN result;
END $$;

ALTER FUNCTION refresh_container_owner_clients(uuid[]) RENAME TO refresh_owner_snapshot;
CREATE FUNCTION refresh_container_owner_clients(container_ids uuid[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE today date:=billing_today(); locked_ids uuid[]; p record; previous_owner uuid; warehouse_status text; event uuid;
BEGIN
 -- Acquire the full union in the same order as stock operations, before processing any plan.
 SELECT array_agg(id) INTO locked_ids FROM (
   SELECT c.id FROM container c WHERE (container_ids IS NULL OR c.id=ANY(container_ids))
   AND (EXISTS(SELECT 1 FROM container_ownership_period a WHERE a.container_id=c.id AND a.start_container_owner_history_id IS NULL
          AND a.effective_date<=today AND NOT a.is_withdrawn AND NOT a.is_cancelled)
     OR EXISTS(SELECT 1 FROM container_owner o JOIN container_owner_effective e USING(id)
          WHERE o.container_id=c.id AND e.client_id IS NOT NULL AND o.client_id IS DISTINCT FROM e.client_id))
   ORDER BY c.id FOR UPDATE OF c
 ) locked;
 IF locked_ids IS NULL THEN RETURN 0; END IF;
 FOR p IN SELECT a.* FROM container_ownership_period a
   WHERE a.container_id=ANY(locked_ids) AND a.start_container_owner_history_id IS NULL
   AND a.effective_date<=today AND NOT a.is_withdrawn AND NOT a.is_cancelled
   ORDER BY a.container_id,a.plan_at,a.id LOOP
    SELECT a.client_id INTO STRICT previous_owner FROM ownership_assignment_timeline a
    WHERE a.container_visit_id=p.container_visit_id AND a.start_container_owner_history_id IS NOT NULL
      AND NOT a.is_cancelled AND NOT a.is_withdrawn AND a.action_at<=p.plan_at
    ORDER BY a.action_at DESC,a.recorded_at DESC,a.ordering_id DESC LIMIT 1;
    IF previous_owner=p.client_id THEN
       UPDATE container_ownership_period SET is_withdrawn=true,withdrawn_at=billing_now(),updated_at=billing_now(),
         withdrawal_reason='Собственник на дату передачи уже совпадает' WHERE id=p.id;
       UPDATE service_order_container SET result_status='SKIPPED',result_reason='Собственник на дату передачи уже совпадает' WHERE container_ownership_period_id=p.id;
       CONTINUE;
    END IF;
    SELECT h.new_status INTO STRICT warehouse_status FROM container_owner_history h
    WHERE h.container_id=p.container_id AND h.order_type<>'SERVICE_ORDER' AND h.occurred_at<=p.plan_at
    ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
    INSERT INTO container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at,storage_period_id)
    VALUES(gen_random_uuid(),p.container_id,previous_owner,p.client_id,warehouse_status,warehouse_status,p.plan_order_id,'SERVICE_ORDER',p.plan_at,p.id)
    RETURNING id INTO event;
    UPDATE container_ownership_period SET start_container_owner_history_id=event,updated_at=billing_now() WHERE id=p.id;
 END LOOP;
 RETURN refresh_owner_snapshot(locked_ids);
END $$;
COMMENT ON COLUMN container_ownership_period.plan_order_id IS 'Заявка, подтвердившая будущее назначение. История появляется при фактическом вступлении в силу.';
COMMENT ON COLUMN container_ownership_period.plan_at IS 'Момент действия запланированной передачи; учитывает порядок передач одного дня.';
COMMENT ON COLUMN container_ownership_period.start_container_owner_history_id IS 'Событие начала владения. Для ещё не вступивших в силу и отозванных планов события нет.';

UPDATE container_ownership_period p SET plan_order_id=x.order_id,plan_at=x.occurred_at,start_container_owner_history_id=NULL
FROM old_plans x WHERE p.id=x.id;
DELETE FROM container_owner_history h USING old_plans x WHERE h.id=x.event_id;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

CREATE TRIGGER ownership_period_origin_immutable BEFORE UPDATE OR DELETE ON container_ownership_period
 FOR EACH ROW EXECUTE FUNCTION protect_ownership_period_start();


CREATE FUNCTION check_actual_transfer_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.occurred_at AT TIME ZONE 'Europe/Moscow')::date > billing_today() THEN
   RAISE EXCEPTION 'Дата фактической передачи ещё не наступила' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER actual_transfer_date BEFORE INSERT ON container_owner_history
 FOR EACH ROW WHEN (NEW.order_type='SERVICE_ORDER') EXECUTE FUNCTION check_actual_transfer_date();
