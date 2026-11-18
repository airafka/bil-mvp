-- Exact chain traversal replaces the stored arrival reference; no historic periods are rebuilt.
LOCK TABLE container_storage_period,container_owner_history IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT id,arrival_history_id FROM container_storage_period LOOP
  IF storage_arrival_history(p.id) IS DISTINCT FROM p.arrival_history_id THEN
   RAISE EXCEPTION 'Invalid storage origin: stored arrival differs from chain for %',p.id USING ERRCODE='23514';
  END IF;
  PERFORM check_storage_period_boundaries(p.id);
 END LOOP;
END $$;
CREATE TEMP TABLE storage_v52_before ON COMMIT DROP AS SELECT to_jsonb(p) AS value FROM container_storage_period_view p;
CREATE TEMP TABLE origin_v52_before ON COMMIT DROP AS
 SELECT o.id,o.receiving_order_id,p.arrival_history_id FROM container_storage_period_origin o JOIN container_storage_period p USING(id);
DROP VIEW container_storage_period_view;
DROP VIEW container_storage_period_origin;
DROP TRIGGER storage_arrival_immutable ON container_storage_period;
DROP FUNCTION protect_storage_arrival();
ALTER TABLE container_storage_period DROP COLUMN arrival_history_id;
CREATE OR REPLACE FUNCTION storage_arrival_history(period_id uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE cursor_id uuid:=period_id; seen uuid[]:=ARRAY[]::uuid[];
 p container_storage_period%ROWTYPE; h container_owner_history_view%ROWTYPE; physical_container uuid;
BEGIN
 LOOP
  IF cursor_id IS NULL OR cursor_id=ANY(seen) THEN
   RAISE EXCEPTION 'Invalid storage origin chain for %: missing predecessor or cycle',period_id USING ERRCODE='23514';
  END IF;
  seen:=array_append(seen,cursor_id);
  SELECT * INTO p FROM container_storage_period WHERE id=cursor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid storage origin period for %',period_id USING ERRCODE='23514'; END IF;
  physical_container:=coalesce(physical_container,p.container_id);
  SELECT * INTO h FROM container_owner_history_view WHERE id=p.start_history_id;
  IF NOT FOUND OR p.container_id<>physical_container OR h.container_id<>physical_container OR h.cancellation THEN
   RAISE EXCEPTION 'Invalid storage origin event for %',period_id USING ERRCODE='23514';
  END IF;
  IF h.operation_type='ARRIVAL' AND h.order_type='RECEIVING_ORDER' THEN
   RETURN h.id;
  END IF;
  IF h.operation_type<>'OWNER_CHANGE' OR h.order_type<>'SERVICE_ORDER' THEN
   RAISE EXCEPTION 'Invalid storage origin boundary for %',period_id USING ERRCODE='23514';
  END IF;
  SELECT id INTO cursor_id FROM container_storage_period WHERE end_history_id=p.start_history_id;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION storage_receiving_order(period_id uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE receipt uuid;
BEGIN
 SELECT order_id INTO STRICT receipt FROM container_owner_history WHERE id=storage_arrival_history(period_id);
 RETURN receipt;
END $$;
CREATE VIEW container_storage_period_origin AS
WITH RECURSIVE chain(id,container_id,end_history_id,receiving_order_id,arrival_history_id) AS (
 SELECT p.id,p.container_id,p.end_history_id,h.order_id,h.id
 FROM container_storage_period p JOIN container_owner_history_view h ON h.id=p.start_history_id
 WHERE h.operation_type='ARRIVAL' AND h.order_type='RECEIVING_ORDER' AND NOT h.cancellation
 UNION
 SELECT p.id,p.container_id,p.end_history_id,chain.receiving_order_id,chain.arrival_history_id
 FROM chain JOIN container_storage_period p ON p.start_history_id=chain.end_history_id AND p.container_id=chain.container_id
 JOIN container_owner_history_view h ON h.id=p.start_history_id
 WHERE h.operation_type='OWNER_CHANGE' AND h.order_type='SERVICE_ORDER' AND NOT h.cancellation
)
SELECT id,receiving_order_id,arrival_history_id FROM chain;
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
 end_owner.id AS shipping_owner_change_order_id,end_owner.number AS shipping_owner_change_order_number,cargo.cargo_name,origin.arrival_history_id
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
  AND EXISTS(SELECT 1 FROM container_storage_period WHERE start_history_id=OLD.id OR end_history_id=OLD.id)
  AND (NEW.container_id,NEW.order_id,NEW.order_type,NEW.occurred_at,
       NEW.new_client_id,NEW.old_client_id,NEW.new_status,NEW.old_status,NEW.storage_period_id)
   IS DISTINCT FROM
      (OLD.container_id,OLD.order_id,OLD.order_type,OLD.occurred_at,
       OLD.new_client_id,OLD.old_client_id,OLD.new_status,OLD.old_status,OLD.storage_period_id) THEN
  RAISE EXCEPTION 'Invalid storage boundary event mutation for %',OLD.id USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_storage_period_boundaries() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE linked_id uuid;
BEGIN
    IF TG_TABLE_NAME='container_storage_period' THEN
        IF TG_OP<>'DELETE' THEN PERFORM check_storage_period_boundaries(NEW.id); END IF;
        -- A changed/removed boundary must not leave its neighbour disconnected.
        IF TG_OP<>'INSERT' THEN
            FOR linked_id IN SELECT id FROM container_storage_period
              WHERE start_history_id=OLD.end_history_id OR end_history_id=OLD.start_history_id
            LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
        END IF;
        IF TG_OP<>'DELETE' THEN
            FOR linked_id IN SELECT id FROM container_storage_period
              WHERE start_history_id=NEW.end_history_id OR end_history_id=NEW.start_history_id
            LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
        END IF;
    ELSE
        FOR linked_id IN SELECT id FROM container_storage_period
          WHERE start_history_id=NEW.id OR end_history_id=NEW.id
        LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
    END IF;
    RETURN NULL;
END $$;
-- The start event is never changed by the lifecycle, including cancellation.
CREATE FUNCTION protect_storage_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.start_history_id,NEW.container_id) IS DISTINCT FROM (OLD.start_history_id,OLD.container_id) THEN
  RAISE EXCEPTION 'Invalid storage origin: start event and container are immutable for %',OLD.id USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER storage_start_immutable BEFORE UPDATE ON container_storage_period
 FOR EACH ROW EXECUTE FUNCTION protect_storage_start();
DO $$ DECLARE pid uuid; BEGIN
 IF EXISTS((SELECT * FROM origin_v52_before EXCEPT ALL SELECT * FROM container_storage_period_origin)
  UNION ALL (SELECT * FROM container_storage_period_origin EXCEPT ALL SELECT * FROM origin_v52_before)) THEN
  RAISE EXCEPTION 'Storage origins changed during V52';
 END IF;
 IF EXISTS((SELECT value FROM storage_v52_before EXCEPT ALL SELECT to_jsonb(p) FROM container_storage_period_view p)
  UNION ALL (SELECT to_jsonb(p) FROM container_storage_period_view p EXCEPT ALL SELECT value FROM storage_v52_before)) THEN
  RAISE EXCEPTION 'Storage report changed during V52';
 END IF;
 FOR pid IN SELECT id FROM container_storage_period LOOP PERFORM check_storage_period_boundaries(pid); END LOOP;
END $$;
COMMENT ON VIEW container_storage_period_origin IS 'Исходные приём и поставка всех периодов по точной цепочке start_history_id/end_history_id, включая аннулированные. Даты не определяют цепочку.';
COMMENT ON VIEW container_storage_period_view IS 'Открытые и завершённые периоды с вычисляемым исходным приёмом. Физической arrival_history_id нет.';
