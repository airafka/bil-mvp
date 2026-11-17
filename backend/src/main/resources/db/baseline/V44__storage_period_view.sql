-- Stored periods remain the source of identity and boundaries. No historical replay.
CREATE VIEW container_storage_period_view AS
SELECT p.id,p.container_id,p.receiving_order_id,p.receiving_history_id,p.shipping_history_id,
 p.status,p.created_at,p.updated_at,p.receiving_order_container_id,p.shipping_order_container_id,p.waybill_container_id,
 ah.occurred_at AS receiving_at,dh.occurred_at AS shipping_at,
 ah.new_client_id AS receiving_owner_id,r.client_id AS receiving_client_id,r.terminal_area_catalog_id AS terminal_area_id,
 CASE WHEN p.receiving_order_container_id IS NOT NULL THEN receiving_row.empty ELSE wc.net_weight=0 END AS is_empty,
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
LEFT JOIN receiving_order_container receiving_row ON receiving_row.id=p.receiving_order_container_id
LEFT JOIN waybill_container wc ON wc.id=p.waybill_container_id
LEFT JOIN shipping_order_container shipping_row ON shipping_row.id=p.shipping_order_container_id
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
  SELECT i.etsng_code_id FROM receiving_order_container_item i WHERE i.receiving_order_container_id=p.receiving_order_container_id
  UNION
  SELECT wp.etsng_code_id FROM waybill_railway_carriage wr JOIN waybill_product wp ON wp.waybill_id=wr.waybill_id
  WHERE wr.id=wc.waybill_railway_carriage_id
 ) products JOIN etsng_code ec ON ec.id=products.etsng_code_id
) cargo ON true
WHERE p.status IN ('OPEN','CLOSED');

-- Fail instead of silently changing old facts. Cancelled visits are intentionally not reported.
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM container_storage_period p
  JOIN container_owner_history h ON h.id=p.receiving_history_id
  LEFT JOIN container_owner_history e ON e.id=p.shipping_history_id
  JOIN receiving_order r ON r.id=p.receiving_order_id
  WHERE (p.receiving_at,p.shipping_at,p.receiving_owner_id,p.receiving_client_id,p.terminal_area_id)
   IS DISTINCT FROM (h.occurred_at,e.occurred_at,h.new_client_id,r.client_id,r.terminal_area_catalog_id)
 ) OR EXISTS (
  SELECT 1 FROM container_storage_period p JOIN container_storage_period_view v USING(id)
  WHERE p.is_empty IS DISTINCT FROM v.is_empty
 ) OR (SELECT count(*) FROM container_storage_period WHERE status IN ('OPEN','CLOSED'))<>(SELECT count(*) FROM container_storage_period_view) THEN
  RAISE EXCEPTION 'Storage view differs from existing periods; migration requires investigation';
 END IF;
 IF EXISTS (SELECT container_id FROM container_storage_period WHERE status='OPEN' GROUP BY container_id HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Multiple open periods for one physical container';
 END IF;
END $$;
DROP INDEX storage_one_open_uq;
ALTER TABLE container_storage_period
 DROP COLUMN receiving_at, DROP COLUMN shipping_at, DROP COLUMN receiving_owner_id,
 DROP COLUMN receiving_client_id, DROP COLUMN terminal_area_id, DROP COLUMN is_empty,
 ADD CONSTRAINT storage_shipping_source_check CHECK(shipping_order_container_id IS NULL OR shipping_history_id IS NOT NULL),
 ADD CONSTRAINT storage_period_status_boundary_check CHECK(
  (status='OPEN' AND shipping_history_id IS NULL) OR (status='CLOSED' AND shipping_history_id IS NOT NULL)
  OR (status='CANCELLED' AND shipping_order_container_id IS NULL));
CREATE UNIQUE INDEX storage_one_open_uq ON container_storage_period(container_id) WHERE status='OPEN';
CREATE INDEX storage_period_container_idx ON container_storage_period(container_id);
CREATE INDEX storage_history_occurred_idx ON container_owner_history(occurred_at DESC,id);

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
   OR (neighbour.container_id,neighbour.receiving_order_id,neighbour.receiving_order_container_id,neighbour.waybill_container_id)
     IS DISTINCT FROM (p.container_id,p.receiving_order_id,p.receiving_order_container_id,p.waybill_container_id)
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
  IF p.status<>'CLOSED' OR z.order_type<>'SHIPPING_ORDER' OR z.storage_period_id IS DISTINCT FROM p.id
   OR NOT EXISTS(SELECT 1 FROM shipping_order_container s WHERE s.id=p.shipping_order_container_id AND s.shipping_order_id=z.order_id) THEN
   RAISE EXCEPTION 'Departure requires its exact shipping row for %',p.id USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO neighbour FROM container_storage_period WHERE receiving_history_id=z.id;
  IF NOT FOUND OR neighbour.id=p.id OR p.shipping_order_container_id IS NOT NULL
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

-- The removed copies formerly rejected changes of the linked event. Keep that protection.
CREATE FUNCTION protect_storage_boundary_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.storage_period_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM container_storage_period WHERE receiving_history_id=OLD.id OR shipping_history_id=OLD.id)
  AND (NEW.container_id,NEW.order_id,NEW.order_type,NEW.operation_type,NEW.occurred_at,NEW.terminal_area_id,
       NEW.new_client_id,NEW.old_client_id,NEW.new_status,NEW.old_status,NEW.cancellation,NEW.storage_period_id)
   IS DISTINCT FROM
      (OLD.container_id,OLD.order_id,OLD.order_type,OLD.operation_type,OLD.occurred_at,OLD.terminal_area_id,
       OLD.new_client_id,OLD.old_client_id,OLD.new_status,OLD.old_status,OLD.cancellation,OLD.storage_period_id) THEN
  RAISE EXCEPTION 'Invalid storage boundary event mutation for %',OLD.id USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER storage_boundary_immutable BEFORE UPDATE ON container_owner_history
 FOR EACH ROW EXECUTE FUNCTION protect_storage_boundary_event();
COMMENT ON VIEW container_storage_period_view IS 'Открытые и завершённые периоды со всеми заявками. Аннулированные периоды исключены; прежние периоды не пересчитываются.';

