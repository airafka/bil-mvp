CREATE VIEW storage_period_sources_candidate AS
SELECT p.id,p.container_id,p.receiving_order_id,p.receiving_history_id,p.shipping_history_id,
 p.status,p.created_at,p.updated_at,receiving_row.id AS receiving_order_container_id,shipping_row.id AS shipping_order_container_id,wc.id AS waybill_container_id,
 ah.occurred_at AS receiving_at,dh.occurred_at AS shipping_at,
 ah.new_client_id AS receiving_owner_id,r.client_id AS receiving_client_id,r.terminal_area_catalog_id AS terminal_area_id,
 CASE WHEN receiving_row.id IS NOT NULL THEN receiving_row.empty ELSE wc.net_weight=0 END AS is_empty,
 s.id AS shipping_order_id,c.code AS container_name,a.name AS area_name,cl.name AS client_name,ow.name AS owner_name,
 r.number::bigint AS receiving_number,s.number::bigint AS shipping_number,
 r.transport_type AS arrival_transport,s.transport_type AS departure_transport,
 ic.name AS arrival_carrier,oc.name AS departure_carrier,r.consignor,cons.name AS consignee,
 shipping_client.name AS shipping_client_name,shipping_owner.name AS shipping_owner_name,
 ah.time_source AS arrival_time_source,dh.time_source AS departure_time_source,
 ah.operation_type AS arrival_operation_type,dh.operation_type AS departure_operation_type,
 ah.order_id AS start_order_id,ah.order_type AS start_order_type,
 CASE WHEN ah.operation_type='ARRIVAL' THEN r.number ELSE start_owner.number END::bigint AS start_order_number,
 dh.order_id AS end_order_id,dh.order_type AS end_order_type,
 CASE WHEN dh.operation_type='DEPARTURE' THEN s.number ELSE end_owner.number END::bigint AS end_order_number,
 start_owner.id AS receiving_owner_change_order_id,start_owner.number AS receiving_owner_change_order_number,
 end_owner.id AS shipping_owner_change_order_id,end_owner.number AS shipping_owner_change_order_number,cargo.cargo_name
FROM container_storage_period p
JOIN container_owner_history ah ON ah.id=p.receiving_history_id
LEFT JOIN container_owner_history dh ON dh.id=p.shipping_history_id
JOIN container c ON c.id=p.container_id
JOIN receiving_order r ON r.id=p.receiving_order_id
JOIN terminal_area_catalog a ON a.id=r.terminal_area_catalog_id
LEFT JOIN client cl ON cl.id=r.client_id
LEFT JOIN client ow ON ow.id=ah.new_client_id
LEFT JOIN receiving_order_container receiving_row ON receiving_row.receiving_order_id=p.receiving_order_id AND receiving_row.container_id=p.container_id AND r.transport_type='VEHICLE'
LEFT JOIN (SELECT wc.*,w.receiving_order_id FROM waybill w
 JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
 JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id) wc
 ON wc.receiving_order_id=p.receiving_order_id AND wc.container_id=p.container_id AND r.transport_type='RAILWAY'
LEFT JOIN shipping_order_container shipping_row ON shipping_row.shipping_order_id=dh.order_id AND shipping_row.container_id=p.container_id
 AND dh.order_type='SHIPPING_ORDER' AND dh.operation_type='DEPARTURE'
LEFT JOIN shipping_order s ON s.id=shipping_row.shipping_order_id
LEFT JOIN service_order start_owner ON start_owner.id=ah.order_id AND ah.order_type='SERVICE_ORDER' AND ah.operation_type='OWNER_CHANGE'
LEFT JOIN service_order end_owner ON end_owner.id=dh.order_id AND dh.order_type='SERVICE_ORDER' AND dh.operation_type='OWNER_CHANGE'
LEFT JOIN route ir ON ir.id=r.route_id AND r.transport_type='VEHICLE'
LEFT JOIN client_related_entity ic ON ic.id=ir.client_related_entity_id
LEFT JOIN route outr ON outr.id=s.route_id AND s.transport_type='VEHICLE'
LEFT JOIN client_related_entity oc ON oc.id=outr.client_related_entity_id
LEFT JOIN client_related_entity cons ON cons.id=s.consignee_id
LEFT JOIN client shipping_client ON shipping_client.id=s.client_id
LEFT JOIN client shipping_owner ON shipping_owner.id=shipping_row.owner_container_id
LEFT JOIN LATERAL (
 SELECT string_agg(DISTINCT ec.code,'; ' ORDER BY ec.code) AS cargo_name
 FROM (
  SELECT i.etsng_code_id FROM receiving_order_container_item i WHERE i.receiving_order_container_id=receiving_row.id
  UNION
  SELECT wp.etsng_code_id FROM waybill_railway_carriage wr JOIN waybill_product wp ON wp.waybill_id=wr.waybill_id
  WHERE wr.id=wc.waybill_railway_carriage_id
 ) products JOIN etsng_code ec ON ec.id=products.etsng_code_id
) cargo ON true
WHERE p.status IN ('OPEN','CLOSED');
DO $$ BEGIN
 IF EXISTS ((SELECT * FROM container_storage_period_view EXCEPT ALL SELECT * FROM storage_period_sources_candidate)
 UNION ALL (SELECT * FROM storage_period_sources_candidate EXCEPT ALL SELECT * FROM container_storage_period_view)) THEN
 RAISE EXCEPTION 'Derived storage tasks differ from stored links; migration requires investigation'; END IF;
END $$;
DROP VIEW container_storage_period_view;
ALTER TABLE storage_period_sources_candidate RENAME TO container_storage_period_view;
ALTER TABLE container_storage_period DROP COLUMN receiving_order_container_id,DROP COLUMN shipping_order_container_id,DROP COLUMN waybill_container_id,
 ADD CONSTRAINT storage_period_status_boundary_check CHECK((status='OPEN' AND shipping_history_id IS NULL) OR (status='CLOSED' AND shipping_history_id IS NOT NULL) OR status='CANCELLED');

-- One canonical document task per active period. Cancelled visits intentionally have no current task.
CREATE FUNCTION check_storage_period_sources(period_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p container_storage_period%ROWTYPE; r receiving_order%ROWTYPE;
        e container_owner_history%ROWTYPE; qty bigint; finished bigint;
BEGIN
 SELECT * INTO p FROM container_storage_period WHERE id=period_id;
 IF NOT FOUND OR p.status='CANCELLED' THEN RETURN; END IF;
 SELECT * INTO STRICT r FROM receiving_order WHERE id=p.receiving_order_id;
 IF r.transport_type='VEHICLE' THEN
  SELECT count(*),count(*) FILTER(WHERE status='FINISHED') INTO qty,finished
  FROM receiving_order_container WHERE receiving_order_id=r.id AND container_id=p.container_id;
 ELSE
  SELECT count(*),count(*) FILTER(WHERE wc.status='FINISHED') INTO qty,finished
  FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
  JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id
  WHERE w.receiving_order_id=r.id AND wc.container_id=p.container_id;
 END IF;
 IF qty<>1 OR finished<>1 OR r.order_status<>'COMPLETED' THEN
  RAISE EXCEPTION 'Invalid storage receiving source for %: exactly one finished task required',p.id USING ERRCODE='23514';
 END IF;
 SELECT * INTO e FROM container_owner_history WHERE id=p.shipping_history_id;
 IF e.operation_type='DEPARTURE' THEN
  SELECT count(*),count(*) FILTER(WHERE sc.status='FINISHED' AND s.order_status='COMPLETED') INTO qty,finished
  FROM shipping_order_container sc JOIN shipping_order s ON s.id=sc.shipping_order_id
  WHERE sc.shipping_order_id=e.order_id AND sc.container_id=p.container_id;
  IF qty<>1 OR finished<>1 THEN
   RAISE EXCEPTION 'Invalid storage shipping source for %: exactly one finished task required',p.id USING ERRCODE='23514';
  END IF;
 END IF;
END $$;

-- Serialise source edits with stock operations on the same physical container.
-- Deferred checks see final cancellation states and allow a released waybill to be reused.
CREATE FUNCTION validate_storage_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row jsonb; after_row jsonb; affected uuid[]; cid uuid; pid uuid;
BEGIN
 before_row:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME IN ('receiving_order_container','shipping_order_container','waybill_container') THEN
  affected:=ARRAY[(before_row->>'container_id')::uuid,(after_row->>'container_id')::uuid];
 ELSIF TG_TABLE_NAME='waybill' THEN
  SELECT array_agg(DISTINCT wc.container_id) INTO affected
  FROM waybill_railway_carriage wr JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id
  WHERE wr.waybill_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid);
 ELSIF TG_TABLE_NAME='waybill_railway_carriage' THEN
  SELECT array_agg(DISTINCT container_id) INTO affected FROM waybill_container
  WHERE waybill_railway_carriage_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid);
 ELSIF TG_TABLE_NAME='receiving_order' THEN
  SELECT array_agg(DISTINCT container_id) INTO affected FROM container_storage_period
  WHERE receiving_order_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid) AND status<>'CANCELLED';
 ELSE
  SELECT array_agg(DISTINCT p.container_id) INTO affected FROM container_storage_period p
  JOIN container_owner_history h ON h.id=p.shipping_history_id
  WHERE h.order_type='SHIPPING_ORDER' AND h.order_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid)
    AND p.status<>'CANCELLED';
 END IF;
 FOR cid IN SELECT DISTINCT x FROM unnest(affected) x WHERE x IS NOT NULL ORDER BY x LOOP
  IF TG_WHEN='BEFORE' THEN
   PERFORM 1 FROM container WHERE id=cid FOR UPDATE;
  ELSE
   FOR pid IN SELECT id FROM container_storage_period WHERE container_id=cid AND status<>'CANCELLED' LOOP
    PERFORM check_storage_period_sources(pid);
   END LOOP;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE INDEX storage_period_receiving_order_idx ON container_storage_period(receiving_order_id,container_id);
CREATE INDEX storage_waybill_task_lookup_idx ON waybill_container(container_id,waybill_railway_carriage_id);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['receiving_order_container','shipping_order_container','waybill_container',
                            'waybill','waybill_railway_carriage','receiving_order','shipping_order'] LOOP
  EXECUTE format('CREATE TRIGGER storage_source_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION validate_storage_source_change()',tbl);
  EXECUTE format('CREATE CONSTRAINT TRIGGER storage_source_integrity AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_storage_source_change()',tbl);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION check_storage_period_boundaries(period_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
 p container_storage_period%ROWTYPE;
 a container_owner_history%ROWTYPE;
 z container_owner_history%ROWTYPE;
 neighbour container_storage_period%ROWTYPE;
 area uuid;
 effective_owner uuid;
BEGIN
 SELECT * INTO p FROM container_storage_period WHERE id=period_id;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM check_storage_period_sources(p.id);
 SELECT terminal_area_catalog_id INTO STRICT area FROM receiving_order WHERE id=p.receiving_order_id;
 SELECT * INTO a FROM container_owner_history WHERE id=p.receiving_history_id;
 IF a.operation_type NOT IN ('ARRIVAL','OWNER_CHANGE') OR a.cancellation
  OR a.container_id IS DISTINCT FROM p.container_id OR a.terminal_area_id IS DISTINCT FROM area
  OR a.occurred_at IS NULL OR a.storage_period_id IS DISTINCT FROM p.id THEN
  RAISE EXCEPTION 'Invalid storage start event for %',p.id USING ERRCODE='23514';
 END IF;
 IF a.operation_type='ARRIVAL' THEN
  IF a.order_type<>'RECEIVING_ORDER' OR a.order_id IS DISTINCT FROM p.receiving_order_id THEN
   RAISE EXCEPTION 'Invalid storage receiving order for %',p.id USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO neighbour FROM container_storage_period WHERE shipping_history_id=a.id;
  IF NOT FOUND OR neighbour.id=p.id OR a.order_type<>'SERVICE_ORDER'
   OR a.old_client_id IS NOT DISTINCT FROM a.new_client_id
   OR a.old_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR a.new_status<>a.old_status
   OR (neighbour.container_id,neighbour.receiving_order_id)
     IS DISTINCT FROM (p.container_id,p.receiving_order_id)
   OR (neighbour.status='CANCELLED')<>(p.status='CANCELLED') THEN
   RAISE EXCEPTION 'Invalid storage ownership predecessor for %',p.id USING ERRCODE='23514';
  END IF;
 END IF;
 IF p.shipping_history_id IS NULL THEN RETURN; END IF;
 SELECT * INTO z FROM container_owner_history WHERE id=p.shipping_history_id;
 IF z.operation_type NOT IN ('DEPARTURE','OWNER_CHANGE') OR z.cancellation
  OR z.container_id IS DISTINCT FROM p.container_id OR z.terminal_area_id IS DISTINCT FROM area
  OR z.occurred_at IS NULL OR z.occurred_at<a.occurred_at THEN
  RAISE EXCEPTION 'Invalid storage end event for %',p.id USING ERRCODE='23514';
 END IF;
 IF z.operation_type='DEPARTURE' THEN
  IF p.status<>'CLOSED' OR z.order_type<>'SHIPPING_ORDER' OR z.storage_period_id IS DISTINCT FROM p.id THEN
   RAISE EXCEPTION 'Departure requires its exact shipping row for %',p.id USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO neighbour FROM container_storage_period WHERE receiving_history_id=z.id;
  IF NOT FOUND OR neighbour.id=p.id
   OR z.storage_period_id IS DISTINCT FROM neighbour.id OR (neighbour.status='CANCELLED')<>(p.status='CANCELLED') THEN
   RAISE EXCEPTION 'Invalid storage ownership successor for %',p.id USING ERRCODE='23514';
  END IF;
  SELECT h.new_client_id INTO effective_owner FROM container_owner_history h
  WHERE h.storage_period_id=p.id AND h.operation_type='OWNER_CHANGE' AND h.id<>p.receiving_history_id
   AND h.occurred_at<=z.occurred_at
   AND NOT EXISTS(SELECT 1 FROM container_storage_period x WHERE x.receiving_history_id=h.id)
  ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
  effective_owner:=coalesce(effective_owner,a.new_client_id);
  IF z.old_client_id IS DISTINCT FROM effective_owner THEN
   RAISE EXCEPTION 'Storage owner does not match transfer for %',p.id USING ERRCODE='23514';
  END IF;
 END IF;
END $$;


DO $$ DECLARE pid uuid; BEGIN FOR pid IN SELECT id FROM container_storage_period WHERE status<>'CANCELLED' LOOP PERFORM check_storage_period_sources(pid); END LOOP; END $$;

COMMENT ON VIEW container_storage_period_view IS 'Открытые и завершённые периоды: строки КТК определяются по исходной поставке или событию вывоза и физическому КТК. Аннулированные периоды исключены.';
