-- Remove redundant area and time provenance; retain actual event dates and all other values.
LOCK TABLE container_owner_history,container_storage_period,receiving_order,shipping_order IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE history_v50_before ON COMMIT DROP AS SELECT to_jsonb(h)-'time_source'-'terminal_area_id' AS value FROM container_owner_history_view h;
CREATE TEMP TABLE storage_v50_before ON COMMIT DROP AS SELECT to_jsonb(p)-'arrival_time_source'-'departure_time_source'-'terminal_area_id'-'area_name' AS value FROM container_storage_period_view p;
DROP VIEW container_storage_period_view;
DROP VIEW container_owner_history_view;
ALTER TABLE container_owner_history DROP COLUMN terminal_area_id,DROP COLUMN time_source;
CREATE VIEW container_owner_history_view AS
SELECT h.*,history_operation_type(h.order_type,h.old_status,h.new_status) AS operation_type FROM container_owner_history h;
CREATE VIEW container_storage_period_view AS
SELECT p.id,p.container_id,origin.receiving_order_id,p.start_history_id,p.end_history_id,
 p.status,p.created_at,p.updated_at,receiving_row.id AS receiving_order_container_id,shipping_row.id AS shipping_order_container_id,wc.id AS waybill_container_id,
 ah.occurred_at AS receiving_at,dh.occurred_at AS shipping_at,
 ah.new_client_id AS receiving_owner_id,r.client_id AS receiving_client_id,
 CASE WHEN receiving_row.id IS NOT NULL THEN receiving_row.empty ELSE wc.net_weight=0 END AS is_empty,
 s.id AS shipping_order_id,c.code AS container_name,cl.name AS client_name,ow.name AS owner_name,
 r.number::bigint AS receiving_number,s.number::bigint AS shipping_number,
 r.transport_type AS arrival_transport,s.transport_type AS departure_transport,
 ic.name AS arrival_carrier,oc.name AS departure_carrier,r.consignor,cons.name AS consignee,
 shipping_client.name AS shipping_client_name,shipping_owner.name AS shipping_owner_name,
 ah.operation_type AS arrival_operation_type,dh.operation_type AS departure_operation_type,
 ah.order_id AS start_order_id,ah.order_type AS start_order_type,
 CASE WHEN ah.operation_type='ARRIVAL' THEN r.number ELSE start_owner.number END::bigint AS start_order_number,
 dh.order_id AS end_order_id,dh.order_type AS end_order_type,
 CASE WHEN dh.operation_type='DEPARTURE' THEN s.number ELSE end_owner.number END::bigint AS end_order_number,
 start_owner.id AS receiving_owner_change_order_id,start_owner.number AS receiving_owner_change_order_number,
 end_owner.id AS shipping_owner_change_order_id,end_owner.number AS shipping_owner_change_order_number,cargo.cargo_name,p.arrival_history_id
FROM container_storage_period p
JOIN container_storage_period_origin origin ON origin.id=p.id
JOIN container_owner_history_view ah ON ah.id=p.start_history_id
LEFT JOIN container_owner_history_view dh ON dh.id=p.end_history_id
JOIN container c ON c.id=p.container_id
JOIN receiving_order r ON r.id=origin.receiving_order_id
LEFT JOIN client cl ON cl.id=r.client_id
LEFT JOIN client ow ON ow.id=ah.new_client_id
LEFT JOIN receiving_order_container receiving_row ON receiving_row.receiving_order_id=origin.receiving_order_id AND receiving_row.container_id=p.container_id AND r.transport_type='VEHICLE'
LEFT JOIN (SELECT wc.*,w.receiving_order_id FROM waybill w
 JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
 JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id) wc
 ON wc.receiving_order_id=origin.receiving_order_id AND wc.container_id=p.container_id AND r.transport_type='RAILWAY'
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
CREATE OR REPLACE FUNCTION check_storage_period_boundaries(period_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
 p container_storage_period%ROWTYPE;
 a container_owner_history_view%ROWTYPE;
 z container_owner_history_view%ROWTYPE;
 neighbour container_storage_period%ROWTYPE;
 area uuid;
 origin_order uuid;
 effective_owner uuid;
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
   OR a.old_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR a.new_status<>a.old_status
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
  SELECT h.new_client_id INTO effective_owner FROM container_owner_history_view h
  WHERE h.storage_period_id=p.id AND h.operation_type='OWNER_CHANGE' AND h.id<>p.start_history_id
   AND h.occurred_at<=z.occurred_at
   AND NOT EXISTS(SELECT 1 FROM container_storage_period x WHERE x.start_history_id=h.id)
  ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
  effective_owner:=coalesce(effective_owner,a.new_client_id);
  IF z.old_client_id IS DISTINCT FROM effective_owner THEN
   RAISE EXCEPTION 'Storage owner does not match transfer for %',p.id USING ERRCODE='23514';
  END IF;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION protect_storage_boundary_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.storage_period_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM container_storage_period WHERE start_history_id=OLD.id OR end_history_id=OLD.id OR arrival_history_id=OLD.id)
  AND (NEW.container_id,NEW.order_id,NEW.order_type,NEW.occurred_at,
       NEW.new_client_id,NEW.old_client_id,NEW.new_status,NEW.old_status,NEW.cancellation,NEW.storage_period_id)
   IS DISTINCT FROM
      (OLD.container_id,OLD.order_id,OLD.order_type,OLD.occurred_at,
       OLD.new_client_id,OLD.old_client_id,OLD.new_status,OLD.old_status,OLD.cancellation,OLD.storage_period_id) THEN
  RAISE EXCEPTION 'Invalid storage boundary event mutation for %',OLD.id USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE pid uuid; BEGIN
 IF EXISTS((SELECT value FROM history_v50_before EXCEPT ALL SELECT to_jsonb(h) FROM container_owner_history_view h)
  UNION ALL (SELECT to_jsonb(h) FROM container_owner_history_view h EXCEPT ALL SELECT value FROM history_v50_before)) THEN
  RAISE EXCEPTION 'History values changed during V50' USING ERRCODE='23514';
 END IF;
 IF EXISTS((SELECT value FROM storage_v50_before EXCEPT ALL SELECT to_jsonb(p) FROM container_storage_period_view p)
  UNION ALL (SELECT to_jsonb(p) FROM container_storage_period_view p EXCEPT ALL SELECT value FROM storage_v50_before)) THEN
  RAISE EXCEPTION 'Storage report changed during V50';
 END IF;
 FOR pid IN SELECT id FROM container_storage_period LOOP PERFORM check_storage_period_boundaries(pid); END LOOP;
END $$;
COMMENT ON VIEW container_owner_history_view IS 'История КТК с вычисляемым operation_type. Площадка и источник времени удалены; occurred_at сохраняется.';
