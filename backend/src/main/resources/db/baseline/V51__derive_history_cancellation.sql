-- Preserve historical cancellation semantics, deriving the flag from the known transition.
LOCK TABLE container_owner_history,container_storage_period IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM container_owner_history WHERE cancellation IS DISTINCT FROM (history_operation_type(order_type,old_status,new_status) IN ('CANCEL_ARRIVAL','CANCEL_DEPARTURE','CANCEL_RECEIVING_RESERVATION','CANCEL_SHIPPING_RESERVATION'))) THEN
  RAISE EXCEPTION 'History cancellation cannot be derived without changing existing meaning' USING ERRCODE='23514';
 END IF;
END $$;
CREATE TEMP TABLE history_v51_before ON COMMIT DROP AS SELECT to_jsonb(h) AS value FROM container_owner_history_view h;
CREATE TEMP TABLE storage_v51_before ON COMMIT DROP AS SELECT to_jsonb(p) AS value FROM container_storage_period_view p;
DROP VIEW container_storage_period_view;
DROP VIEW container_owner_history_view;
ALTER TABLE container_owner_history DROP COLUMN cancellation;
CREATE VIEW container_owner_history_view AS SELECT h.*,
 history_operation_type(order_type,old_status,new_status) AS operation_type,
 (history_operation_type(order_type,old_status,new_status) IN ('CANCEL_ARRIVAL','CANCEL_DEPARTURE','CANCEL_RECEIVING_RESERVATION','CANCEL_SHIPPING_RESERVATION')) AS cancellation FROM container_owner_history h;
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
CREATE OR REPLACE FUNCTION protect_storage_boundary_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.storage_period_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM container_storage_period WHERE start_history_id=OLD.id OR end_history_id=OLD.id OR arrival_history_id=OLD.id)
  AND (NEW.container_id,NEW.order_id,NEW.order_type,NEW.occurred_at,
       NEW.new_client_id,NEW.old_client_id,NEW.new_status,NEW.old_status,NEW.storage_period_id)
   IS DISTINCT FROM
      (OLD.container_id,OLD.order_id,OLD.order_type,OLD.occurred_at,
       OLD.new_client_id,OLD.old_client_id,OLD.new_status,OLD.old_status,OLD.storage_period_id) THEN
  RAISE EXCEPTION 'Invalid storage boundary event mutation for %',OLD.id USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE pid uuid; BEGIN
 IF EXISTS((SELECT value FROM history_v51_before EXCEPT ALL SELECT to_jsonb(h) FROM container_owner_history_view h)
  UNION ALL (SELECT to_jsonb(h) FROM container_owner_history_view h EXCEPT ALL SELECT value FROM history_v51_before)) THEN
  RAISE EXCEPTION 'History values changed during V51';
 END IF;
 IF EXISTS((SELECT value FROM storage_v51_before EXCEPT ALL SELECT to_jsonb(p) FROM container_storage_period_view p)
  UNION ALL (SELECT to_jsonb(p) FROM container_storage_period_view p EXCEPT ALL SELECT value FROM storage_v51_before)) THEN
  RAISE EXCEPTION 'Storage report changed during V51';
 END IF;
 FOR pid IN SELECT id FROM container_storage_period LOOP PERFORM check_storage_period_boundaries(pid); END LOOP;
END $$;
COMMENT ON VIEW container_owner_history_view IS 'История КТК с вычисляемыми operation_type и cancellation по виду заявки и старому/новому статусу. Физически эти признаки не хранятся.';
