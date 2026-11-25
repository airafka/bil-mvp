-- Keep the existing IDs, foreign keys and historical documents.
ALTER TABLE service_order RENAME COLUMN client_id TO new_client_owner_id;
ALTER TABLE service_order RENAME COLUMN source_client_id TO old_client_owner_id;
ALTER TABLE service_order RENAME COLUMN effective_date TO transferred_at;
ALTER VIEW service_order_current RENAME COLUMN client_id TO new_client_owner_id;
ALTER VIEW service_order_current RENAME COLUMN source_client_id TO old_client_owner_id;
ALTER VIEW service_order_current RENAME COLUMN effective_date TO transferred_at;
ALTER TABLE shipping_order_container RENAME COLUMN owner_container_id TO container_owner_id;
ALTER TABLE receiving_order RENAME COLUMN transport_waybill_number TO waybill;

ALTER TABLE receiving_order ADD COLUMN shipper_id uuid REFERENCES client_related_entity(id);
-- Preserve historical names even when the client directory has since changed.
INSERT INTO client_related_entity(id,name,active,transport_catalog_archived)
SELECT coalesce(cl.id,gen_random_uuid()), r.consignor, false, true
FROM (SELECT DISTINCT consignor FROM receiving_order WHERE consignor IS NOT NULL) r
LEFT JOIN client cl ON cl.name=r.consignor
WHERE NOT EXISTS (SELECT 1 FROM client_related_entity p WHERE p.name=r.consignor)
ON CONFLICT (name) DO NOTHING;

UPDATE receiving_order r SET shipper_id=p.id
FROM client_related_entity p WHERE p.name=r.consignor;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM receiving_order r LEFT JOIN client_related_entity p ON p.id=r.shipper_id
               WHERE r.consignor IS DISTINCT FROM p.name) THEN
        RAISE EXCEPTION 'Unresolved receiving order shipper';
    END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE VIEW container_storage_period_view AS
SELECT p.id,
    p.container_id,
    origin.receiving_order_id,
    p.start_history_id,
    p.end_history_id,
    p.status,
    p.created_at,
    p.updated_at,
    receiving_row.id AS receiving_order_container_id,
    shipping_row.id AS shipping_order_container_id,
    wc.id AS waybill_container_id,
    ah.occurred_at AS receiving_at,
    dh.occurred_at AS shipping_at,
    ah.new_client_id AS receiving_owner_id,
    r.client_id AS receiving_client_id,
        CASE
            WHEN receiving_row.id IS NOT NULL THEN receiving_row.empty
            ELSE wc.net_weight = 0::numeric
        END AS is_empty,
    s.id AS shipping_order_id,
    c.code AS container_name,
    cl.name AS client_name,
    ow.name AS owner_name,
    r.number::bigint AS receiving_number,
    s.number::bigint AS shipping_number,
    r.transport_type AS arrival_transport,
    s.transport_type AS departure_transport,
    ic.name AS arrival_carrier,
    oc.name AS departure_carrier,
    shipper.name AS consignor,
    cons.name AS consignee,
    shipping_client.name AS shipping_client_name,
    shipping_owner.name AS shipping_owner_name,
    ah.operation_type AS arrival_operation_type,
    dh.operation_type AS departure_operation_type,
    ah.order_id AS start_order_id,
    ah.order_type AS start_order_type,
        CASE
            WHEN ah.operation_type::text = 'ARRIVAL'::text THEN r.number::bigint
            ELSE start_owner.number
        END AS start_order_number,
    dh.order_id AS end_order_id,
    dh.order_type AS end_order_type,
        CASE
            WHEN dh.operation_type::text = 'DEPARTURE'::text THEN s.number::bigint
            ELSE end_owner.number
        END AS end_order_number,
    start_owner.id AS receiving_owner_change_order_id,
    start_owner.number AS receiving_owner_change_order_number,
    end_owner.id AS shipping_owner_change_order_id,
    end_owner.number AS shipping_owner_change_order_number,
    cargo.cargo_name,
    origin.arrival_history_id
   FROM container_storage_period_at(billing_today()) p(id, container_id, start_history_id, end_history_id, status, created_at, updated_at)
     JOIN container_storage_period_origin origin ON origin.id = p.id
     JOIN container_owner_history_view ah ON ah.id = p.start_history_id
     LEFT JOIN container_owner_history_view dh ON dh.id = p.end_history_id
     JOIN container c ON c.id = p.container_id
     JOIN receiving_order r ON r.id = origin.receiving_order_id
     LEFT JOIN client_related_entity shipper ON shipper.id = r.shipper_id
     LEFT JOIN client cl ON cl.id = r.client_id
     LEFT JOIN client ow ON ow.id = ah.new_client_id
     LEFT JOIN receiving_order_container receiving_row ON receiving_row.receiving_order_id = origin.receiving_order_id AND receiving_row.container_id = p.container_id AND r.transport_type::text = 'VEHICLE'::text
     LEFT JOIN ( SELECT wc_1.id,
            wc_1.waybill_railway_carriage_id,
            wc_1.container_id,
            wc_1.weight,
            wc_1.net_weight,
            wc_1.owner,
            wc_1.owner_container_id,
            wc_1.status,
            w.receiving_order_id
           FROM waybill w
             JOIN waybill_railway_carriage wr ON wr.waybill_id = w.id
             JOIN waybill_container wc_1 ON wc_1.waybill_railway_carriage_id = wr.id) wc ON wc.receiving_order_id = origin.receiving_order_id AND wc.container_id = p.container_id AND r.transport_type::text = 'RAILWAY'::text
     LEFT JOIN shipping_order_container shipping_row ON shipping_row.shipping_order_id = dh.order_id AND shipping_row.container_id = p.container_id AND dh.order_type::text = 'SHIPPING_ORDER'::text AND dh.operation_type::text = 'DEPARTURE'::text
     LEFT JOIN shipping_order s ON s.id = shipping_row.shipping_order_id
     LEFT JOIN service_order start_owner ON start_owner.id = ah.order_id AND ah.order_type::text = 'SERVICE_ORDER'::text AND ah.operation_type::text = 'OWNER_CHANGE'::text
     LEFT JOIN service_order end_owner ON end_owner.id = dh.order_id AND dh.order_type::text = 'SERVICE_ORDER'::text AND dh.operation_type::text = 'OWNER_CHANGE'::text
     LEFT JOIN route ir ON ir.id = r.route_id AND r.transport_type::text = 'VEHICLE'::text
     LEFT JOIN client_related_entity ic ON ic.id = ir.client_related_entity_id
     LEFT JOIN route outr ON outr.id = s.route_id AND s.transport_type::text = 'VEHICLE'::text
     LEFT JOIN client_related_entity oc ON oc.id = outr.client_related_entity_id
     LEFT JOIN client_related_entity cons ON cons.id = s.consignee_id
     LEFT JOIN client shipping_client ON shipping_client.id = s.client_id
     LEFT JOIN client shipping_owner ON shipping_owner.id = shipping_row.container_owner_id
     LEFT JOIN LATERAL ( SELECT string_agg(DISTINCT ec.code::text, '; '::text ORDER BY (ec.code::text)) AS cargo_name
           FROM ( SELECT i.etsng_code_id
                   FROM receiving_order_container_item i
                  WHERE i.receiving_order_container_id = receiving_row.id
                UNION
                 SELECT wp.etsng_code_id
                   FROM waybill_railway_carriage wr
                     JOIN waybill_product wp ON wp.waybill_id = wr.waybill_id
                  WHERE wr.id = wc.waybill_railway_carriage_id) products
             JOIN etsng_code ec ON ec.id = products.etsng_code_id) cargo ON true
  WHERE p.status::text = ANY (ARRAY['OPEN'::character varying::text, 'CLOSED'::character varying::text]);

ALTER TABLE receiving_order DROP COLUMN consignor;

CREATE OR REPLACE FUNCTION public.apply_ownership_order(doc uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE ids uuid[]; reason text;
BEGIN
    PERFORM 1 FROM service_order WHERE id=doc AND status='SCHEDULED' AND transferred_at<=billing_today() FOR UPDATE;
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
END $function$;

CREATE OR REPLACE FUNCTION public.check_ownership_order_row(row_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE r record;
BEGIN
    SELECT sc.*,s.status AS order_status,s.new_client_owner_id AS target,s.transferred_at AS day,
           h.occurred_at AS actual_at,h.order_id AS actual_order INTO r
    FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
    LEFT JOIN container_period p ON p.id=sc.container_period_id
    LEFT JOIN container_owner_history h ON h.id=p.start_container_owner_history_id WHERE sc.id=row_id;
    IF NOT FOUND OR r.result_status NOT IN ('PLANNED','APPLIED') THEN RETURN; END IF;
    IF (r.order_status NOT IN ('SCHEDULED','DONE') OR (r.result_status='PLANNED' AND r.order_status<>'SCHEDULED')) OR r.target<>r.plan_client_id OR r.day IS DISTINCT FROM (r.plan_at AT TIME ZONE 'Europe/Moscow')::date
       OR (r.actual_at,r.actual_order) IS DISTINCT FROM (r.plan_at,r.service_order_id)
    THEN RAISE EXCEPTION 'Ownership row % does not match its order or event',row_id USING ERRCODE='23514'; END IF;
    IF r.container_period_id IS NOT NULL THEN PERFORM check_period_origin(r.container_period_id); END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.check_period_origin(period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
             AND sc.container_visit_id=fact.container_visit_id AND s.id=fact.order_id AND s.new_client_owner_id=fact.client_id))
    THEN RAISE EXCEPTION 'Invalid event, owner, visit or document row for period %',period_id USING ERRCODE='23514';
    END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.ownership_export_payload(doc uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
    SELECT jsonb_build_object(
        'ServiceOrder',jsonb_build_object('id',s.id,'number',s.number,'clientId',s.new_client_owner_id,
            'typeEquipment','CONTAINER','quantity',jsonb_array_length(items.links),'comment',s.comment,
            'status','DONE','completionAt',to_char(s.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
        'ServiceOrderContainer',items.links,'Container',items.containers,
        'Client',jsonb_build_array(jsonb_build_object('id',cl.id,'name',cl.name)),
        'ServiceOrderRailwayCarriage','[]'::jsonb,'RailwayCarriage','[]'::jsonb,
        'RailwayCarriageType','[]'::jsonb,'ContainerTypeIso','[]'::jsonb)
    FROM service_order s JOIN client cl ON cl.id=s.new_client_owner_id
    CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',sc.id,'serviceOrderId',s.id,'containerId',c.id) ORDER BY c.id) AS links,
               jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'weight',c.weight,'containerType',c.container_type,
                   'liftingCapacity',c.lifting_capacity,'active',true,'refrigerator',c.container_type IN ('REFRIGERATOR_20','REFRIGERATOR_40')) ORDER BY c.id) AS containers
        FROM service_order_container sc JOIN container c ON c.id=sc.container_id
        WHERE sc.service_order_id=s.id AND sc.result_status='APPLIED'
    ) items WHERE s.id=doc
$function$;

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
    LEFT JOIN service_order own ON own.id = own_order
    JOIN LATERAL (
        SELECT op.client_id, op.effective_date, op.action_at AS occurred_at
        FROM ownership_assignment_timeline op
        WHERE op.container_visit_id = v.id
          AND op.effective_date <= transfer_date
        ORDER BY op.effective_date DESC, op.action_at DESC, op.recorded_at DESC, op.ordering_id DESC
        LIMIT 1
    ) p ON true
    WHERE EXISTS (SELECT 1 FROM visit_receiving_tasks t WHERE t.receiving_order_id=v.receiving_order_id
                  AND t.container_id=v.container_id AND t.status='FINISHED') AND o.status = 'ON_TERMINAL' AND NOT v.is_cancelled AND v.shipping_date IS NULL
      AND v.receiving_date <= transfer_date AND v.receiving_date <= billing_today()
      AND p.client_id <> target_client
      AND (own.old_client_owner_id IS NULL OR own.old_client_owner_id = p.client_id)
      AND NOT EXISTS (
          SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id = sc.service_order_id
          WHERE sc.container_id = o.container_id AND sc.result_status='DRAFT' AND s.status = 'DRAFT' AND s.id IS DISTINCT FROM own_order
      );
$function$;

CREATE OR REPLACE FUNCTION public.refresh_owner_snapshot(container_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE changed_ids uuid[]; changed integer;
BEGIN
 PERFORM billing_today();
 SELECT array_agg(id ORDER BY id) INTO changed_ids FROM (
  SELECT c.id FROM container c JOIN container_owner o ON o.container_id=c.id
  JOIN container_owner_effective e ON e.id=o.id
  WHERE (container_ids IS NULL OR c.id=ANY(container_ids))
   AND e.client_id IS NOT NULL AND o.client_id IS DISTINCT FROM e.client_id
  ORDER BY c.id FOR UPDATE OF c
 ) locked;
 IF changed_ids IS NULL THEN RETURN 0; END IF;
 -- Re-resolve after acquiring locks: another operation may have completed while waiting.
 UPDATE container_owner o SET client_id=e.client_id,version=o.version+1,
  updated_at=billing_now() AT TIME ZONE 'UTC',updated_by='local'
 FROM container_owner_effective e WHERE e.id=o.id AND o.container_id=ANY(changed_ids)
  AND e.client_id IS NOT NULL AND o.client_id IS DISTINCT FROM e.client_id;
 GET DIAGNOSTICS changed=ROW_COUNT;
 UPDATE shipping_order_container sc SET container_owner_id=o.client_id
 FROM shipping_order s,container_owner o
 WHERE s.id=sc.shipping_order_id AND s.order_status='DRAFT' AND o.container_id=sc.container_id
  AND o.container_id=ANY(changed_ids) AND sc.container_owner_id IS DISTINCT FROM o.client_id;
 RETURN changed;
END $function$;
