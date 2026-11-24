-- Persist the document lifecycle independently of the reporting calendar.
ALTER TABLE service_order DROP CONSTRAINT service_order_status_check,
    DROP CONSTRAINT service_order_schedule_check,
    ADD COLUMN execution_error text;

UPDATE service_order s SET status = CASE WHEN EXISTS (
    SELECT 1 FROM service_order_container WHERE service_order_id=s.id AND result_status='APPLIED'
) AND NOT EXISTS (
    SELECT 1 FROM service_order_container WHERE service_order_id=s.id AND result_status NOT IN ('WITHDRAWN','APPLIED')
) THEN 'DONE' ELSE 'SCHEDULED' END WHERE status <> 'DRAFT';

CREATE OR REPLACE VIEW service_order_current AS
SELECT id,number,client_id,service,comment,status::varchar(20),completion_at,created_at,created_by,
       updated_at,updated_by,effective_date,source_client_id,execution_error
FROM service_order;

CREATE OR REPLACE VIEW service_order_container_current AS
SELECT id,service_order_id,container_id,container_visit_id,expected_client_id,expected_status,
       result_status::varchar(20),result_reason,container_period_id
FROM service_order_container WHERE result_status <> 'WITHDRAWN';

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
       OR (r.result_status='APPLIED' AND (r.actual_at,r.actual_order) IS DISTINCT FROM (r.plan_at,r.service_order_id))
    THEN RAISE EXCEPTION 'Ownership row % does not match its order or event',row_id USING ERRCODE='23514'; END IF;
    IF r.container_period_id IS NOT NULL THEN PERFORM check_period_origin(r.container_period_id); END IF;
END $$;

CREATE OR REPLACE FUNCTION withdraw_ownership_order(doc uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sc record;
BEGIN
    FOR sc IN SELECT * FROM service_order_container WHERE service_order_id=doc AND result_status<>'WITHDRAWN'
              ORDER BY container_id FOR UPDATE LOOP
        IF sc.container_period_id IS NOT NULL THEN
            RAISE EXCEPTION 'Нельзя отозвать фактическую передачу' USING ERRCODE='23514';
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

SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE service_order ADD CONSTRAINT service_order_status_check CHECK (status IN ('DRAFT','SCHEDULED','DONE'));
SET CONSTRAINTS ALL DEFERRED;

CREATE TABLE service_order_export (
    service_order_id uuid PRIMARY KEY REFERENCES service_order(id),
    sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    sent_at timestamptz,
    message_id uuid
);
CREATE INDEX service_order_export_pending ON service_order_export(next_attempt_at) WHERE sent_at IS NULL;
COMMENT ON TABLE service_order_export IS 'Исходящие пакеты смены собственника для Datareon/TOS. Один снимок на проведённую заявку.';

CREATE FUNCTION ownership_export_payload(doc uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'ServiceOrder',jsonb_build_object('id',s.id,'number',s.number,'clientId',s.client_id,
            'typeEquipment','CONTAINER','quantity',jsonb_array_length(items.links),'comment',s.comment,
            'status','DONE','completionAt',to_char(s.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
        'ServiceOrderContainer',items.links,'Container',items.containers,
        'Client',jsonb_build_array(jsonb_build_object('id',cl.id,'name',cl.name)),
        'ServiceOrderRailwayCarriage','[]'::jsonb,'RailwayCarriage','[]'::jsonb,
        'RailwayCarriageType','[]'::jsonb,'ContainerTypeIso','[]'::jsonb)
    FROM service_order s JOIN client cl ON cl.id=s.client_id
    CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',sc.id,'serviceOrderId',s.id,'containerId',c.id) ORDER BY c.id) AS links,
               jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'weight',c.weight,'containerType',c.container_type,
                   'liftingCapacity',c.lifting_capacity,'active',true,'refrigerator',c.container_type IN ('REFRIGERATOR_20','REFRIGERATOR_40')) ORDER BY c.id) AS containers
        FROM service_order_container sc JOIN container c ON c.id=sc.container_id
        WHERE sc.service_order_id=s.id AND sc.result_status='APPLIED'
    ) items WHERE s.id=doc
$$;

DROP FUNCTION refresh_container_owner_clients(uuid[]);

CREATE FUNCTION apply_ownership_order(doc uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE ids uuid[]; plan record; previous_owner uuid; warehouse_status text; event_id uuid; reason text;
BEGIN
    PERFORM 1 FROM service_order WHERE id=doc AND status='SCHEDULED' AND effective_date<=billing_today() FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT array_agg(id) INTO ids FROM (
        SELECT c.id FROM container c JOIN service_order_container sc ON sc.container_id=c.id
        WHERE sc.service_order_id=doc AND sc.result_status<>'WITHDRAWN' ORDER BY c.id FOR UPDATE OF c
    ) locked;
    -- All changes to owners, periods and the outbound packet share one transaction.
    BEGIN
        IF ids IS NULL THEN RAISE EXCEPTION 'В заявке нет КТК для передачи.' USING ERRCODE='P7801'; END IF;
        FOR plan IN SELECT sc.*,c.code FROM service_order_container sc JOIN container c ON c.id=sc.container_id
            WHERE sc.service_order_id=doc AND sc.result_status<>'WITHDRAWN' ORDER BY c.id FOR UPDATE OF sc
        LOOP
            IF plan.result_status='APPLIED' THEN CONTINUE; END IF; -- A fact imported from an older schema.
            IF plan.result_status<>'PLANNED' OR NOT EXISTS (
                SELECT 1 FROM container_visit_facts v JOIN container_owner_current o ON o.container_visit_id=v.id
                WHERE v.id=plan.container_visit_id AND v.container_id=plan.container_id AND o.status='ON_TERMINAL'
                    AND NOT v.is_cancelled AND v.shipping_date IS NULL
            ) THEN RAISE EXCEPTION 'КТК % недоступен для передачи. %',plan.code,coalesce(plan.result_reason,'Проверьте заезд и остаток.') USING ERRCODE='P7801';
            END IF;
            IF EXISTS (SELECT 1 FROM service_order_container prior WHERE prior.container_id=plan.container_id
                AND prior.result_status='PLANNED' AND prior.plan_at<plan.plan_at)
            THEN RAISE EXCEPTION 'По КТК % ожидает выполнения более ранняя передача.',plan.code USING ERRCODE='P7801'; END IF;
            SELECT p.client_id INTO previous_owner FROM container_period p
            JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
            WHERE p.container_visit_id=plan.container_visit_id AND h.occurred_at<=plan.plan_at
            ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
            IF previous_owner IS NULL OR previous_owner=plan.plan_client_id THEN
                RAISE EXCEPTION 'Проверьте собственника КТК % на дату передачи.',plan.code USING ERRCODE='P7801';
            END IF;
            SELECT h.new_status INTO STRICT warehouse_status FROM container_owner_history h
            WHERE h.container_id=plan.container_id AND h.order_type<>'SERVICE_ORDER' AND h.occurred_at<=plan.plan_at
            ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
            INSERT INTO container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at)
            VALUES(gen_random_uuid(),plan.container_id,previous_owner,plan.plan_client_id,warehouse_status,warehouse_status,
                   doc,'SERVICE_ORDER',plan.plan_at) RETURNING id INTO event_id;
            PERFORM apply_container_history(event_id);
            UPDATE service_order_container sc SET container_period_id=p.id,result_status='APPLIED',result_reason=NULL
            FROM container_period p WHERE p.start_container_owner_history_id=event_id AND sc.id=plan.id;
            IF NOT FOUND THEN RAISE EXCEPTION 'Missing period for ownership event %',event_id; END IF;
        END LOOP;
        PERFORM refresh_owner_snapshot(ids);
        UPDATE service_order SET status='DONE',execution_error=NULL,updated_at=billing_now() AT TIME ZONE 'UTC' WHERE id=doc;
        INSERT INTO service_order_export(service_order_id,payload) VALUES(doc,ownership_export_payload(doc));
    EXCEPTION WHEN SQLSTATE 'P7801' THEN
        reason := SQLERRM;
        UPDATE service_order SET execution_error=reason WHERE id=doc AND execution_error IS DISTINCT FROM reason;
        RETURN reason;
    END;
    RETURN NULL;
END $$;
