-- The worker and migration must see the same last committed delivery state.
LOCK TABLE service_order_export IN ACCESS EXCLUSIVE MODE;

CREATE TABLE outbound_data (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type varchar(100) NOT NULL,
    message_type varchar(255) NOT NULL,
    root_object_id uuid NOT NULL,
    success boolean,
    message_id uuid,
    response_code integer,
    error_message text,
    payload text,
    attempts integer NOT NULL DEFAULT 0,
    last_attempt_at timestamp,
    created_at timestamp NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
    created_by varchar(50) NOT NULL DEFAULT 'local',
    updated_at timestamp,
    updated_by varchar(50)
);
-- An ownership order can complete only once. Other message types have their own lifecycle.
CREATE UNIQUE INDEX outbound_ownership_order ON outbound_data(root_object_id)
    WHERE entity_type='SERVICE_ORDER' AND message_type='SERVICE_ORDER_CHAIN_PACKAGE';
CREATE INDEX outbound_data_pending ON outbound_data(message_type,created_at DESC)
    WHERE success IS NOT TRUE AND attempts<5;

-- V78 recorded sent_at or a retry deadline. For failed attempts recover the attempt time
-- using the exact V78 delay. There is no historical HTTP response code in V78.
WITH previous AS (
    SELECT e.*, CASE WHEN sent_at IS NOT NULL THEN sent_at WHEN attempts>0 THEN
        next_attempt_at - interval '5 seconds' * (1 << least(attempts-1,7)) END AS attempted_at
    FROM service_order_export e
)
INSERT INTO outbound_data(entity_type,message_type,root_object_id,success,message_id,error_message,payload,
                          attempts,last_attempt_at,created_at,updated_at,updated_by)
SELECT 'SERVICE_ORDER','SERVICE_ORDER_CHAIN_PACKAGE',service_order_id,
       CASE WHEN sent_at IS NOT NULL THEN true WHEN attempts>0 THEN false END,
       message_id,last_error,payload::text,attempts,attempted_at AT TIME ZONE 'UTC',
       created_at AT TIME ZONE 'UTC',attempted_at AT TIME ZONE 'UTC',
       CASE WHEN attempted_at IS NOT NULL THEN 'local' END
FROM previous;

CREATE OR REPLACE FUNCTION apply_ownership_order(doc uuid) RETURNS text LANGUAGE plpgsql AS $$
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
        INSERT INTO outbound_data(entity_type,message_type,root_object_id)
        VALUES('SERVICE_ORDER','SERVICE_ORDER_CHAIN_PACKAGE',doc);
    EXCEPTION WHEN SQLSTATE 'P7801' THEN
        reason := SQLERRM;
        UPDATE service_order SET execution_error=reason WHERE id=doc AND execution_error IS DISTINCT FROM reason;
        RETURN reason;
    END;
    RETURN NULL;
END $$;

DROP TABLE service_order_export;
COMMENT ON TABLE outbound_data IS 'Очередь исходящих сообщений биллинга для отправки через Datareon.';
