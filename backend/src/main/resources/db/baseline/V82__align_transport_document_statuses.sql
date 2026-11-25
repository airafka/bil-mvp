-- Transport documents and routes use the codes from OrderStatus and RouteStatus.
ALTER TABLE receiving_order DROP CONSTRAINT ck_receiving_order_status;
ALTER TABLE shipping_order DROP CONSTRAINT ck_shipping_order_status;
ALTER TABLE route DROP CONSTRAINT route_status_check;

UPDATE receiving_order SET order_status = CASE order_status
    WHEN 'CONFIRMED' THEN 'ACCEPTED' WHEN 'COMPLETED' THEN 'DONE' WHEN 'CANCELLED' THEN 'REJECTED' END
WHERE order_status IN ('CONFIRMED','COMPLETED','CANCELLED');

UPDATE shipping_order SET order_status = CASE order_status
    WHEN 'CONFIRMED' THEN 'ACCEPTED' WHEN 'COMPLETED' THEN 'DONE' WHEN 'CANCELLED' THEN 'REJECTED' END
WHERE order_status IN ('CONFIRMED','COMPLETED','CANCELLED');

UPDATE route SET status = CASE status
    WHEN 'CONFIRMED' THEN 'ACCEPTED' WHEN 'COMPLETED' THEN 'DONE' WHEN 'CANCELLED' THEN 'REJECTED' END
WHERE status IN ('CONFIRMED','COMPLETED','CANCELLED');

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE receiving_order ADD CONSTRAINT ck_receiving_order_status
    CHECK (order_status IN ('DRAFT','ACCEPTED','DONE','REJECTED'));
ALTER TABLE shipping_order ADD CONSTRAINT ck_shipping_order_status
    CHECK (order_status IN ('DRAFT','ACCEPTED','DONE','REJECTED'));
ALTER TABLE route ADD CONSTRAINT route_status_check
    CHECK (status IN ('DRAFT','ACCEPTED','DONE','REJECTED'));

CREATE OR REPLACE FUNCTION public.previous_stock_order(ktk uuid, cancelled_order uuid, kind character varying)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE cutoff timestamp; first_event timestamp; matches integer; previous_order uuid;
BEGIN
    IF kind NOT IN ('RECEIVING_ORDER','SHIPPING_ORDER') THEN
        RAISE EXCEPTION 'Unsupported stock order type' USING ERRCODE='23514';
    END IF;
    SELECT count(*),min(created_at) INTO matches,cutoff FROM container_owner_history_view
      WHERE container_id=ktk AND order_id=cancelled_order AND order_type=kind AND NOT cancellation
        AND operation_type=CASE kind WHEN 'RECEIVING_ORDER' THEN 'RESERVE_RECEIVING' ELSE 'RESERVE_SHIPPING' END
        AND new_status=CASE kind WHEN 'RECEIVING_ORDER' THEN 'EXPECTED' ELSE 'RESERVED_OUT' END;
    SELECT min(created_at) INTO first_event FROM container_owner_history_view
      WHERE container_id=ktk AND order_id=cancelled_order AND order_type=kind;
    IF matches<>1 OR cutoff IS DISTINCT FROM first_event THEN
        RAISE EXCEPTION 'Missing or ambiguous reservation history for container %, order %',ktk,cancelled_order
          USING ERRCODE='23514';
    END IF;
    SELECT h.order_id INTO previous_order FROM container_owner_history_view h
      JOIN (
        SELECT id,order_status FROM receiving_order WHERE kind='RECEIVING_ORDER'
        UNION ALL SELECT id,order_status FROM shipping_order WHERE kind='SHIPPING_ORDER'
      ) o ON o.id=h.order_id
      WHERE h.container_id=ktk AND h.order_type=kind AND h.order_id<>cancelled_order
        AND o.order_status<>'REJECTED' AND h.created_at<cutoff
      ORDER BY h.created_at DESC LIMIT 1;
    RETURN previous_order;
END $function$;

CREATE OR REPLACE FUNCTION public.validate_container_stock_state()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE o container_owner%ROWTYPE; v container_visit_facts%ROWTYPE;
BEGIN
 SELECT * INTO o FROM container_owner WHERE container_id=coalesce(NEW.container_id,OLD.container_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO v FROM container_visit_facts WHERE container_id=o.container_id AND receiving_order_id=o.receiving_order_id;
 -- In a free or expected state this reference can point to a previous physical departure.
 IF o.status IN ('EXPECTED','ON_TERMINAL') AND o.shipping_order_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM container_visit_facts previous_visit
                    WHERE previous_visit.container_id=o.container_id
                      AND previous_visit.shipping_order_id=o.shipping_order_id AND NOT previous_visit.is_cancelled) THEN
    RAISE EXCEPTION 'Previous shipping order must have a physical departure for this container' USING ERRCODE='23514';
 END IF;
 IF o.status='EXPECTED' THEN
   IF v.id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM receiving_order WHERE id=o.receiving_order_id AND order_status='ACCEPTED') THEN
      RAISE EXCEPTION 'Expected stock requires a confirmed receiving reservation';
   END IF;
   RETURN NULL;
 END IF;
 IF o.receiving_order_id IS NOT NULL AND (v.id IS NULL OR v.cancellation_container_owner_history_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Stock must reference the actual receiving for this container';
 END IF;
 IF o.status IN ('ON_TERMINAL','RESERVED_OUT') AND (v.id IS NULL OR v.shipping_container_owner_history_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Warehouse state requires an open physical visit';
 END IF;
 IF o.status='DEPARTED' AND v.id IS NOT NULL AND v.shipping_container_owner_history_id IS NULL THEN
    RAISE EXCEPTION 'Departed stock refers to an open visit';
 END IF;
 IF o.status='RESERVED_OUT' AND o.shipping_order_id IS NULL THEN
    RAISE EXCEPTION 'Invalid current shipping reservation';
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE VIEW railway_carriage_owner AS
 SELECT DISTINCT ON (h.railway_carriage_id) h.id,
    h.railway_carriage_id,
    h.client_owner_id,
    h.receiving_order_id,
    h.shipping_order_id,
    h.status,
    h.occurred_at
   FROM railway_carriage_owner_history h
     LEFT JOIN receiving_order r ON r.id = h.receiving_order_id
     LEFT JOIN shipping_order s ON s.id = h.shipping_order_id
  WHERE COALESCE(r.order_status, s.order_status)::text <> 'REJECTED'::text
  ORDER BY h.railway_carriage_id, h.id DESC;
