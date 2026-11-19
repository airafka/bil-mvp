-- Separate physical receiving/shipping, ownership and the current warehouse state.
-- V1-V54 and existing business history are immutable. Compatibility views retain period UUIDs.
CREATE TEMP TABLE visit_migration_periods ON COMMIT DROP AS
 SELECT p.*,storage_arrival_history(p.id) AS receiving_history_id,storage_receiving_order(p.id) AS receiving_order_id
 FROM container_storage_period p;
CREATE TEMP TABLE visit_migration_owners ON COMMIT DROP AS SELECT * FROM container_owner;
CREATE TEMP TABLE visit_migration_report ON COMMIT DROP AS SELECT * FROM container_storage_period_view;

CREATE TABLE container_visit (
 id uuid PRIMARY KEY, container_id uuid NOT NULL REFERENCES container(id),
 receiving_order_id uuid NOT NULL REFERENCES receiving_order(id),
 receiving_order_container_id uuid REFERENCES receiving_order_container(id) ON DELETE SET NULL,
 waybill_container_id uuid REFERENCES waybill_container(id) ON DELETE SET NULL,
 receiving_date date, receiving_container_owner_history_id uuid UNIQUE REFERENCES container_owner_history(id),
 shipping_order_container_id uuid REFERENCES shipping_order_container(id) ON DELETE SET NULL,
 shipping_date date, shipping_container_owner_history_id uuid UNIQUE REFERENCES container_owner_history(id),
 is_cancelled boolean NOT NULL DEFAULT false,
 cancellation_container_owner_history_id uuid REFERENCES container_owner_history(id),
 created_at timestamptz NOT NULL DEFAULT billing_now(),updated_at timestamptz NOT NULL DEFAULT billing_now(),
 UNIQUE(receiving_order_id,container_id), UNIQUE(id,container_id),
 CHECK((receiving_date IS NULL) = (receiving_container_owner_history_id IS NULL)),
 CHECK((shipping_date IS NULL) = (shipping_container_owner_history_id IS NULL)),
 CHECK(shipping_date IS NULL OR (receiving_date IS NOT NULL AND shipping_date>=receiving_date)),
 CHECK(NOT (receiving_order_container_id IS NOT NULL AND waybill_container_id IS NOT NULL)),
 CHECK(is_cancelled OR num_nonnulls(receiving_order_container_id,waybill_container_id)=1),
 CHECK(is_cancelled = (cancellation_container_owner_history_id IS NOT NULL))
);
CREATE UNIQUE INDEX container_visit_one_current ON container_visit(container_id) WHERE NOT is_cancelled AND shipping_date IS NULL;
CREATE INDEX container_visit_history ON container_visit(container_id,receiving_date,id);

CREATE TABLE container_ownership_period (
 id uuid PRIMARY KEY, container_id uuid NOT NULL REFERENCES container(id),
 container_visit_id uuid, client_id uuid NOT NULL REFERENCES client(id),
 record_type varchar(20) NOT NULL CHECK(record_type IN ('EXPECTED','STORAGE','OUTSIDE_STORAGE')),
 start_date date,end_date_exclusive date,
 start_container_owner_history_id uuid NOT NULL UNIQUE REFERENCES container_owner_history(id),
 end_container_owner_history_id uuid UNIQUE REFERENCES container_owner_history(id),
 is_cancelled boolean NOT NULL DEFAULT false,
 cancellation_container_owner_history_id uuid REFERENCES container_owner_history(id),
 created_at timestamptz NOT NULL DEFAULT billing_now(),updated_at timestamptz NOT NULL DEFAULT billing_now(),
 FOREIGN KEY(container_visit_id,container_id) REFERENCES container_visit(id,container_id),
 CHECK((record_type='STORAGE' AND container_visit_id IS NOT NULL AND start_date IS NOT NULL
   AND (end_date_exclusive IS NULL)=(end_container_owner_history_id IS NULL)
   AND (end_date_exclusive IS NULL OR end_date_exclusive>=start_date))
   OR (record_type<>'STORAGE' AND start_date IS NULL AND end_date_exclusive IS NULL AND end_container_owner_history_id IS NULL)),
 CHECK(record_type='OUTSIDE_STORAGE' OR container_visit_id IS NOT NULL),
 CHECK(is_cancelled = (cancellation_container_owner_history_id IS NOT NULL))
);
CREATE UNIQUE INDEX ownership_period_one_open ON container_ownership_period(container_visit_id)
 WHERE record_type='STORAGE' AND NOT is_cancelled AND end_date_exclusive IS NULL;
CREATE UNIQUE INDEX ownership_period_one_expected ON container_ownership_period(container_visit_id)
 WHERE record_type='EXPECTED' AND NOT is_cancelled;
CREATE INDEX ownership_period_container ON container_ownership_period(container_id,start_container_owner_history_id);
CREATE INDEX ownership_period_visit ON container_ownership_period(container_visit_id,start_date,id);

-- Reproduce physical documents in recorded order, including cancellation. No dates are invented.
DO $$ DECLARE h record; v uuid; row_id uuid; rail_id uuid; n integer; cancelled uuid; BEGIN
 FOR h IN SELECT * FROM container_owner_history_view ORDER BY container_id,created_at,id LOOP
  IF h.operation_type='RESERVE_RECEIVING' THEN
   SELECT id INTO cancelled FROM container_owner_history_view WHERE container_id=h.container_id AND order_id=h.order_id
    AND operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') ORDER BY created_at DESC LIMIT 1;
   row_id:=NULL;rail_id:=NULL;
   IF (SELECT transport_type FROM receiving_order WHERE id=h.order_id)='VEHICLE' THEN
    SELECT count(*),(array_agg(id))[1] INTO n,row_id FROM receiving_order_container WHERE receiving_order_id=h.order_id AND container_id=h.container_id;
   ELSE
    SELECT count(*),(array_agg(wc.id))[1] INTO n,rail_id FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
     JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=h.order_id AND wc.container_id=h.container_id;
   END IF;
   IF n>1 OR (n<>1 AND cancelled IS NULL) THEN RAISE EXCEPTION 'Receiving source requires reconciliation: %, %',h.order_id,h.container_id; END IF;
   v:=gen_random_uuid();
   INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id,is_cancelled,cancellation_container_owner_history_id)
    VALUES(v,h.container_id,h.order_id,row_id,rail_id,cancelled IS NOT NULL,cancelled);
   INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id,is_cancelled,cancellation_container_owner_history_id)
    VALUES(gen_random_uuid(),h.container_id,v,h.new_client_id,'EXPECTED',h.id,cancelled IS NOT NULL,cancelled);
  ELSIF h.operation_type='ARRIVAL' THEN
   SELECT id INTO STRICT v FROM container_visit WHERE container_id=h.container_id AND receiving_order_id=h.order_id;
   UPDATE container_visit SET receiving_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,receiving_container_owner_history_id=h.id WHERE id=v;
   DELETE FROM container_ownership_period WHERE container_visit_id=v AND record_type='EXPECTED';
  ELSIF h.operation_type IN ('DEPARTURE','CANCEL_DEPARTURE') THEN
   IF h.operation_type='CANCEL_DEPARTURE' THEN
    SELECT cv.id INTO STRICT v FROM container_visit cv JOIN container_owner_history sh ON sh.id=cv.shipping_container_owner_history_id WHERE cv.container_id=h.container_id AND sh.order_id=h.order_id;
   ELSE
    SELECT cv.id INTO v FROM container_visit cv JOIN container_owner_history rh ON rh.id=cv.receiving_container_owner_history_id WHERE cv.container_id=h.container_id AND rh.created_at<=h.created_at AND cv.shipping_date IS NULL AND NOT cv.is_cancelled ORDER BY rh.created_at DESC LIMIT 1;
   END IF;
   IF v IS NULL THEN RAISE EXCEPTION 'Shipping without an unambiguous receiving: %',h.id; END IF;
   SELECT count(*),(array_agg(id))[1] INTO n,row_id FROM shipping_order_container WHERE shipping_order_id=h.order_id AND container_id=h.container_id;
   IF n<>1 THEN RAISE EXCEPTION 'Shipping source requires reconciliation: %',h.id; END IF;
   UPDATE container_visit SET shipping_date=CASE WHEN h.operation_type='DEPARTURE' THEN (h.occurred_at AT TIME ZONE 'Europe/Moscow')::date END,
    shipping_container_owner_history_id=CASE WHEN h.operation_type='DEPARTURE' THEN h.id END,
    shipping_order_container_id=CASE WHEN h.operation_type='DEPARTURE' THEN row_id END WHERE id=v;
  ELSIF h.operation_type='OWNER_CHANGE' AND h.new_status='EXPECTED' THEN
   SELECT cv.id INTO v FROM container_visit cv JOIN container_owner_history_view rh ON rh.order_id=cv.receiving_order_id
    AND rh.container_id=cv.container_id AND rh.operation_type='RESERVE_RECEIVING'
    WHERE cv.container_id=h.container_id AND rh.created_at<=h.created_at ORDER BY rh.created_at DESC LIMIT 1;
   UPDATE container_ownership_period SET client_id=h.new_client_id,start_container_owner_history_id=h.id WHERE container_visit_id=v AND record_type='EXPECTED';
  ELSIF (h.operation_type='OWNER_CHANGE' AND h.new_status='DEPARTED') OR h.operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
   INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id)
    VALUES(gen_random_uuid(),h.container_id,h.new_client_id,'OUTSIDE_STORAGE',h.id);
  END IF;
 END LOOP;
END $$;

INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,end_date_exclusive,
 start_container_owner_history_id,end_container_owner_history_id,is_cancelled,cancellation_container_owner_history_id,created_at,updated_at)
 SELECT p.id,p.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,
  (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date+CASE WHEN e.order_type='SHIPPING_ORDER' THEN 1 ELSE 0 END,
  p.start_history_id,p.end_history_id,p.status='CANCELLED',CASE WHEN p.status='CANCELLED' THEN v.cancellation_container_owner_history_id END,p.created_at,p.updated_at
 FROM visit_migration_periods p JOIN container_visit v ON v.receiving_order_id=p.receiving_order_id AND v.container_id=p.container_id
 JOIN container_owner_history h ON h.id=p.start_history_id LEFT JOIN container_owner_history e ON e.id=p.end_history_id;

ALTER TABLE container_owner ADD COLUMN container_visit_id uuid, ADD COLUMN version bigint NOT NULL DEFAULT 0;
ALTER TABLE container_owner ADD CONSTRAINT container_owner_visit_fk FOREIGN KEY(container_visit_id,container_id) REFERENCES container_visit(id,container_id);
UPDATE container_owner o SET container_visit_id=v.id FROM container_visit v WHERE v.receiving_order_id=o.receiving_order_id AND v.container_id=o.container_id;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM container_owner WHERE status<>'DEPARTED' AND container_visit_id IS NULL) THEN
  RAISE EXCEPTION 'Current warehouse state has no receiving; explicit reconciliation is required';
 END IF;
 IF EXISTS(SELECT 1 FROM container_owner o LEFT JOIN LATERAL(
  SELECT p.client_id FROM container_ownership_period p JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
  WHERE p.container_id=o.container_id AND NOT p.is_cancelled ORDER BY h.created_at DESC,h.id DESC LIMIT 1) p ON true
  WHERE o.client_id IS DISTINCT FROM p.client_id) THEN
  RAISE EXCEPTION 'Ownership migration does not match the current register; history requires reconciliation';
 END IF;
END $$;

-- Pin drafts/plans without changing their effective dates or status.
ALTER TABLE service_order_container ADD COLUMN container_visit_id uuid REFERENCES container_visit(id),
 ADD COLUMN expected_client_id uuid REFERENCES client(id),
 ADD COLUMN expected_status varchar(20) CHECK(expected_status IN ('EXPECTED','ON_TERMINAL','RESERVED_OUT','DEPARTED')),
 ADD COLUMN result_status varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK(result_status IN ('DRAFT','PLANNED','APPLIED','SKIPPED','CANCELLED','BLOCKED')),
 ADD COLUMN result_reason text;
UPDATE service_order_container sc SET container_visit_id=o.container_visit_id,expected_client_id=o.client_id,expected_status=o.status,
 result_status=CASE s.status WHEN 'SCHEDULED' THEN 'PLANNED' WHEN 'DONE' THEN 'APPLIED' ELSE 'DRAFT' END
 FROM service_order s CROSS JOIN container_owner o WHERE s.id=sc.service_order_id AND o.container_id=sc.container_id;

UPDATE service_order_container sc SET container_visit_id=p.container_visit_id,expected_client_id=h.old_client_id
 FROM container_owner_history h JOIN container_ownership_period p ON p.id=h.storage_period_id
 WHERE h.order_type='SERVICE_ORDER' AND h.order_id=sc.service_order_id AND h.container_id=sc.container_id;
ALTER TABLE service_order DROP CONSTRAINT service_order_status_check;
ALTER TABLE service_order ADD CONSTRAINT service_order_status_check CHECK(status IN ('DRAFT','SCHEDULED','DONE','PARTIAL','CANCELLED'));
CREATE INDEX service_order_container_visit ON service_order_container(container_visit_id) WHERE result_status IN ('PLANNED','BLOCKED');

-- Preserve the old public read contract, not a second writable copy.
DROP VIEW container_storage_period_view;
DROP VIEW container_storage_period_origin;
ALTER TABLE container_owner_history DROP CONSTRAINT history_storage_period_fk;
DROP TABLE container_storage_period;
ALTER TABLE container_owner_history ADD CONSTRAINT history_storage_period_fk FOREIGN KEY(storage_period_id) REFERENCES container_ownership_period(id);
CREATE VIEW container_storage_period AS
 SELECT id,container_id,start_container_owner_history_id AS start_history_id,end_container_owner_history_id AS end_history_id,
  (CASE WHEN is_cancelled THEN 'CANCELLED' WHEN end_date_exclusive IS NULL THEN 'OPEN' ELSE 'CLOSED' END)::varchar(20) AS status,created_at,updated_at
 FROM container_ownership_period WHERE record_type='STORAGE';
CREATE VIEW container_storage_period_origin AS
 SELECT p.id,p.container_id,v.receiving_order_id,v.receiving_container_owner_history_id AS arrival_history_id
 FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id WHERE p.record_type='STORAGE';
CREATE OR REPLACE FUNCTION storage_arrival_history(period_id uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE result uuid; BEGIN
 SELECT v.receiving_container_owner_history_id INTO STRICT result FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id WHERE p.id=period_id AND p.record_type='STORAGE';
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION storage_receiving_order(period_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT v.receiving_order_id FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id WHERE p.id=period_id AND p.record_type='STORAGE'
$$;
ALTER TABLE container_owner DROP COLUMN client_id,DROP COLUMN receiving_order_id;
-- A pointer to an earlier shipping is historical, not a current reservation. Its event remains intact.
UPDATE container_owner SET shipping_order_id=NULL WHERE status IN ('EXPECTED','ON_TERMINAL');
CREATE VIEW container_owner_current AS
 SELECT o.*,v.receiving_order_id,p.client_id FROM container_owner o LEFT JOIN container_visit v ON v.id=o.container_visit_id
 LEFT JOIN LATERAL(SELECT p.client_id FROM container_ownership_period p JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
   WHERE p.container_id=o.container_id AND NOT p.is_cancelled ORDER BY h.created_at DESC,h.id DESC LIMIT 1) p ON true;

COMMENT ON TABLE container_visit IS 'Физический цикл receiving → shipping одного КТК, без собственника. Повторный receiving создаёт новый цикл.';
COMMENT ON TABLE container_ownership_period IS 'Единый учёт собственников: EXPECTED — назначение до receiving; STORAGE — фактическое хранение; OUTSIDE_STORAGE — назначение вне хранения.';
COMMENT ON COLUMN container_ownership_period.end_date_exclusive IS 'Исключающая граница: дата передачи либо день после shipping. Фактическая дата shipping хранится в container_visit.';
COMMENT ON TABLE container_owner IS 'Текущее складское состояние без собственника. Собственник вычисляется через container_owner_current из container_ownership_period.';
COMMENT ON COLUMN container_owner.container_visit_id IS 'Текущий или последний физический цикл КТК; связь относится к тому же container_id.';
COMMENT ON COLUMN service_order_container.container_visit_id IS 'Физический цикл, зафиксированный при подтверждении передачи; не переносится на повторный receiving автоматически.';
COMMENT ON COLUMN service_order_container.expected_client_id IS 'Ожидаемый прежний собственник при подтверждении; перепроверяется перед исполнением.';

CREATE VIEW public.container_storage_period_view AS
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
            WHEN (receiving_row.id IS NOT NULL) THEN receiving_row.empty
            ELSE (wc.net_weight = (0)::numeric)
        END AS is_empty,
    s.id AS shipping_order_id,
    c.code AS container_name,
    cl.name AS client_name,
    ow.name AS owner_name,
    (r.number)::bigint AS receiving_number,
    (s.number)::bigint AS shipping_number,
    r.transport_type AS arrival_transport,
    s.transport_type AS departure_transport,
    ic.name AS arrival_carrier,
    oc.name AS departure_carrier,
    r.consignor,
    cons.name AS consignee,
    shipping_client.name AS shipping_client_name,
    shipping_owner.name AS shipping_owner_name,
    ah.operation_type AS arrival_operation_type,
    dh.operation_type AS departure_operation_type,
    ah.order_id AS start_order_id,
    ah.order_type AS start_order_type,
        CASE
            WHEN ((ah.operation_type)::text = 'ARRIVAL'::text) THEN (r.number)::bigint
            ELSE start_owner.number
        END AS start_order_number,
    dh.order_id AS end_order_id,
    dh.order_type AS end_order_type,
        CASE
            WHEN ((dh.operation_type)::text = 'DEPARTURE'::text) THEN (s.number)::bigint
            ELSE end_owner.number
        END AS end_order_number,
    start_owner.id AS receiving_owner_change_order_id,
    start_owner.number AS receiving_owner_change_order_number,
    end_owner.id AS shipping_owner_change_order_id,
    end_owner.number AS shipping_owner_change_order_number,
    cargo.cargo_name,
    origin.arrival_history_id
   FROM (((((((((((((((((((((public.container_storage_period p
     JOIN public.container_storage_period_origin origin ON ((origin.id = p.id)))
     JOIN public.container_owner_history_view ah ON ((ah.id = p.start_history_id)))
     LEFT JOIN public.container_owner_history_view dh ON ((dh.id = p.end_history_id)))
     JOIN public.container c ON ((c.id = p.container_id)))
     JOIN public.receiving_order r ON ((r.id = origin.receiving_order_id)))
     LEFT JOIN public.client cl ON ((cl.id = r.client_id)))
     LEFT JOIN public.client ow ON ((ow.id = ah.new_client_id)))
     LEFT JOIN public.receiving_order_container receiving_row ON (((receiving_row.receiving_order_id = origin.receiving_order_id) AND (receiving_row.container_id = p.container_id) AND ((r.transport_type)::text = 'VEHICLE'::text))))
     LEFT JOIN ( SELECT wc_1.id,
            wc_1.waybill_railway_carriage_id,
            wc_1.container_id,
            wc_1.weight,
            wc_1.net_weight,
            wc_1.owner,
            wc_1.owner_container_id,
            wc_1.status,
            w.receiving_order_id
           FROM ((public.waybill w
             JOIN public.waybill_railway_carriage wr ON ((wr.waybill_id = w.id)))
             JOIN public.waybill_container wc_1 ON ((wc_1.waybill_railway_carriage_id = wr.id)))) wc ON (((wc.receiving_order_id = origin.receiving_order_id) AND (wc.container_id = p.container_id) AND ((r.transport_type)::text = 'RAILWAY'::text))))
     LEFT JOIN public.shipping_order_container shipping_row ON (((shipping_row.shipping_order_id = dh.order_id) AND (shipping_row.container_id = p.container_id) AND ((dh.order_type)::text = 'SHIPPING_ORDER'::text) AND ((dh.operation_type)::text = 'DEPARTURE'::text))))
     LEFT JOIN public.shipping_order s ON ((s.id = shipping_row.shipping_order_id)))
     LEFT JOIN public.service_order start_owner ON (((start_owner.id = ah.order_id) AND ((ah.order_type)::text = 'SERVICE_ORDER'::text) AND ((ah.operation_type)::text = 'OWNER_CHANGE'::text))))
     LEFT JOIN public.service_order end_owner ON (((end_owner.id = dh.order_id) AND ((dh.order_type)::text = 'SERVICE_ORDER'::text) AND ((dh.operation_type)::text = 'OWNER_CHANGE'::text))))
     LEFT JOIN public.route ir ON (((ir.id = r.route_id) AND ((r.transport_type)::text = 'VEHICLE'::text))))
     LEFT JOIN public.client_related_entity ic ON ((ic.id = ir.client_related_entity_id)))
     LEFT JOIN public.route outr ON (((outr.id = s.route_id) AND ((s.transport_type)::text = 'VEHICLE'::text))))
     LEFT JOIN public.client_related_entity oc ON ((oc.id = outr.client_related_entity_id)))
     LEFT JOIN public.client_related_entity cons ON ((cons.id = s.consignee_id)))
     LEFT JOIN public.client shipping_client ON ((shipping_client.id = s.client_id)))
     LEFT JOIN public.client shipping_owner ON ((shipping_owner.id = shipping_row.owner_container_id)))
     LEFT JOIN LATERAL ( SELECT string_agg(DISTINCT (ec.code)::text, '; '::text ORDER BY (ec.code)::text) AS cargo_name
           FROM (( SELECT i.etsng_code_id
                   FROM public.receiving_order_container_item i
                  WHERE (i.receiving_order_container_id = receiving_row.id)
                UNION
                 SELECT wp.etsng_code_id
                   FROM (public.waybill_railway_carriage wr
                     JOIN public.waybill_product wp ON ((wp.waybill_id = wr.waybill_id)))
                  WHERE (wr.id = wc.waybill_railway_carriage_id)) products
             JOIN public.etsng_code ec ON ((ec.id = products.etsng_code_id)))) cargo ON (true))
  WHERE ((p.status)::text = ANY ((ARRAY['OPEN'::character varying, 'CLOSED'::character varying])::text[]));

CREATE OR REPLACE FUNCTION public.validate_storage_period_boundaries() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE linked_id uuid;
BEGIN
    IF TG_TABLE_NAME='container_ownership_period' THEN
        IF TG_OP<>'DELETE' THEN PERFORM check_storage_period_boundaries(NEW.id); END IF;
        -- A changed/removed boundary must not leave its neighbour disconnected.
        IF TG_OP<>'INSERT' THEN
            FOR linked_id IN SELECT id FROM container_storage_period
              WHERE start_history_id=OLD.end_container_owner_history_id OR end_history_id=OLD.start_container_owner_history_id
            LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
        END IF;
        IF TG_OP<>'DELETE' THEN
            FOR linked_id IN SELECT id FROM container_storage_period
              WHERE start_history_id=NEW.end_container_owner_history_id OR end_history_id=NEW.start_container_owner_history_id
            LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
        END IF;
    ELSE
        FOR linked_id IN SELECT id FROM container_storage_period
          WHERE start_history_id=NEW.id OR end_history_id=NEW.id
        LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
    END IF;
    RETURN NULL;
END $$;
-- Called by the stock transaction after inserting its immutable business event.
CREATE FUNCTION apply_container_history(history_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit%ROWTYPE; p container_ownership_period%ROWTYPE;
 row_id uuid; rail_id uuid; count_rows integer; result_id uuid; previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit cv ON cv.id=o.container_visit_id WHERE o.container_id=h.container_id;
 SELECT op.* INTO p FROM container_ownership_period op WHERE op.container_visit_id=v.id AND op.record_type='STORAGE' AND NOT op.is_cancelled AND op.end_date_exclusive IS NULL;
 IF h.operation_type IN ('OWNER_CHANGE','DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT max(occurred_at) INTO latest FROM container_owner_history_view WHERE container_id=h.container_id AND id<>h.id;
  IF latest>h.occurred_at THEN RAISE EXCEPTION 'Операция не может быть раньше предыдущих событий КТК' USING ERRCODE='23514'; END IF;
 END IF;
 IF h.operation_type='RESERVE_RECEIVING' THEN
  UPDATE service_order_container SET result_status='SKIPPED',result_reason='Начат новый receiving; прежняя передача не переносится на него'
   WHERE container_id=h.container_id AND result_status IN ('PLANNED','BLOCKED');
  row_id:=NULL;rail_id:=NULL;
  IF (SELECT transport_type FROM receiving_order WHERE id=h.order_id)='VEHICLE' THEN
   SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM receiving_order_container WHERE receiving_order_id=h.order_id AND container_id=h.container_id;
  ELSE
   SELECT count(*),(array_agg(wc.id))[1] INTO count_rows,rail_id FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
    JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=h.order_id AND wc.container_id=h.container_id;
  END IF;
  IF count_rows<>1 THEN RAISE EXCEPTION 'Receiving requires exactly one container row' USING ERRCODE='23514'; END IF;
  v.id:=gen_random_uuid();
  INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id)
   VALUES(v.id,h.container_id,h.order_id,row_id,rail_id);
  UPDATE container_owner SET container_visit_id=v.id,shipping_order_id=NULL WHERE container_id=h.container_id;
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id)
   VALUES(gen_random_uuid(),h.container_id,v.id,h.new_client_id,'EXPECTED',h.id);
 ELSIF h.operation_type='ARRIVAL' THEN
  IF v.id IS NULL OR v.receiving_order_id<>h.order_id OR v.is_cancelled OR v.receiving_date IS NOT NULL THEN RAISE EXCEPTION 'Receiving cycle is not expected' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET receiving_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,receiving_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET record_type='STORAGE',start_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,
   start_container_owner_history_id=h.id,client_id=h.new_client_id,updated_at=billing_now()
   WHERE container_visit_id=v.id AND record_type='EXPECTED' AND NOT is_cancelled RETURNING id INTO result_id;
  IF result_id IS NULL THEN RAISE EXCEPTION 'Expected ownership assignment is missing' USING ERRCODE='23514'; END IF;
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status IN ('ON_TERMINAL','RESERVED_OUT') THEN
   IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
   UPDATE container_ownership_period SET end_date_exclusive=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,
    end_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=p.id;
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
    VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
  ELSIF h.new_status='EXPECTED' THEN
   UPDATE container_ownership_period SET client_id=h.new_client_id,start_container_owner_history_id=h.id,updated_at=billing_now()
    WHERE container_visit_id=v.id AND record_type='EXPECTED' AND NOT is_cancelled;
   IF NOT FOUND THEN RAISE EXCEPTION 'Expected ownership assignment is missing' USING ERRCODE='23514'; END IF;
  ELSE
   INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id)
    VALUES(gen_random_uuid(),h.container_id,h.new_client_id,'OUTSIDE_STORAGE',h.id);
  END IF;
 ELSIF h.operation_type='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM shipping_order_container WHERE shipping_order_id=h.order_id AND container_id=h.container_id AND status='FINISHED';
  IF count_rows<>1 THEN RAISE EXCEPTION 'Shipping requires exactly one finished row' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,shipping_order_container_id=row_id,
   shipping_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET end_date_exclusive=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date+1,
   end_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=p.id;
  result_id:=p.id;
  UPDATE service_order_container SET result_status='SKIPPED',result_reason='КТК вывезен до исполнения передачи; план не переносится на новый receiving'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
 ELSIF h.operation_type IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
  IF v.id IS NULL OR v.receiving_order_id<>h.order_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  result_id:=p.id;
  UPDATE container_visit SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET is_cancelled=true,cancellation_container_owner_history_id=h.id,updated_at=billing_now() WHERE container_visit_id=v.id;
  UPDATE service_order_container SET result_status='CANCELLED',result_reason='Receiving отменён; передача не исполняется'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
  previous_receiving:=previous_stock_order(h.container_id,h.order_id,'RECEIVING_ORDER');
  UPDATE container_owner SET container_visit_id=(SELECT id FROM container_visit WHERE container_id=h.container_id AND receiving_order_id=previous_receiving),
   shipping_order_id=(SELECT sc.shipping_order_id FROM container_visit cv JOIN shipping_order_container sc ON sc.id=cv.shipping_order_container_id WHERE cv.container_id=h.container_id AND cv.receiving_order_id=previous_receiving)
   WHERE container_id=h.container_id;
  INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id)
   VALUES(gen_random_uuid(),h.container_id,h.new_client_id,'OUTSIDE_STORAGE',h.id);
 ELSIF h.operation_type='CANCEL_DEPARTURE' THEN
  SELECT op.* INTO p FROM container_ownership_period op JOIN container_owner_history e ON e.id=op.end_container_owner_history_id
   WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND e.order_type='SHIPPING_ORDER' AND e.order_id=h.order_id;
  IF p.id IS NULL OR v.is_cancelled OR v.shipping_date IS NULL THEN RAISE EXCEPTION 'Shipping cancellation cycle is not closed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM container_owner_history_view e JOIN container_owner_history shipping ON shipping.id=v.shipping_container_owner_history_id
   WHERE e.container_id=h.container_id AND e.operation_type='OWNER_CHANGE' AND e.new_status='DEPARTED' AND e.created_at>shipping.created_at) THEN
   RAISE EXCEPTION 'Нельзя отменить shipping после смены собственника вне площадки' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_date=NULL,shipping_order_container_id=NULL,shipping_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET end_date_exclusive=NULL,end_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=p.id;
  UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id;
  result_id:=p.id;
 ELSE
  result_id:=p.id;
  IF h.operation_type='CANCEL_SHIPPING_RESERVATION' THEN UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id; END IF;
 END IF;
 UPDATE container_owner_history SET storage_period_id=result_id WHERE id=h.id;
END $$;

CREATE FUNCTION check_container_visit(visit_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v container_visit%ROWTYPE;p record;cursor_date date;found_period boolean:=false;previous_end date;event container_owner_history_view%ROWTYPE;
BEGIN
 SELECT * INTO v FROM container_visit WHERE id=visit_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF v.is_cancelled THEN
  IF EXISTS(SELECT 1 FROM container_ownership_period WHERE container_visit_id=v.id AND NOT is_cancelled) THEN RAISE EXCEPTION 'Cancelled receiving has active ownership'; END IF;
  RETURN;
 END IF;
 IF v.receiving_order_container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM receiving_order_container r WHERE r.id=v.receiving_order_container_id AND r.receiving_order_id=v.receiving_order_id AND r.container_id=v.container_id)
  OR v.waybill_container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM waybill_container wc JOIN waybill_railway_carriage wr ON wr.id=wc.waybill_railway_carriage_id JOIN waybill w ON w.id=wr.waybill_id WHERE wc.id=v.waybill_container_id AND wc.container_id=v.container_id AND w.receiving_order_id=v.receiving_order_id) THEN
  RAISE EXCEPTION 'Receiving row belongs to another visit' USING ERRCODE='23514';
 END IF;
 IF v.receiving_date IS NULL THEN
  IF (SELECT count(*) FROM container_ownership_period WHERE container_visit_id=v.id AND record_type='EXPECTED' AND NOT is_cancelled)<>1 THEN RAISE EXCEPTION 'Expected receiving requires one owner'; END IF;
  RETURN;
 END IF;
 SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.receiving_container_owner_history_id;
 IF event.container_id<>v.container_id OR event.order_id<>v.receiving_order_id OR event.operation_type<>'ARRIVAL'
   OR v.receiving_date IS DISTINCT FROM (event.occurred_at AT TIME ZONE 'Europe/Moscow')::date THEN RAISE EXCEPTION 'Invalid receiving event for cycle %',v.id; END IF;
 IF v.shipping_date IS NOT NULL THEN
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=v.shipping_container_owner_history_id;
  IF event.container_id<>v.container_id OR event.operation_type<>'DEPARTURE' OR v.shipping_date IS DISTINCT FROM (event.occurred_at AT TIME ZONE 'Europe/Moscow')::date
   OR NOT EXISTS(SELECT 1 FROM shipping_order_container WHERE id=v.shipping_order_container_id AND shipping_order_id=event.order_id AND container_id=v.container_id) THEN RAISE EXCEPTION 'Invalid shipping event for cycle %',v.id; END IF;
 END IF;
 cursor_date:=v.receiving_date;
 FOR p IN SELECT op.*,h.created_at AS recorded FROM container_ownership_period op JOIN container_owner_history h ON h.id=op.start_container_owner_history_id
  WHERE op.container_visit_id=v.id AND op.record_type='STORAGE' AND NOT op.is_cancelled ORDER BY h.created_at,h.id LOOP
  IF p.start_date IS DISTINCT FROM cursor_date OR (found_period AND previous_end IS NULL) THEN RAISE EXCEPTION 'Ownership periods overlap or have gaps: %',v.id; END IF;
  PERFORM check_storage_period_boundaries(p.id);
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=p.start_container_owner_history_id;
  IF p.client_id<>event.new_client_id OR p.start_date IS DISTINCT FROM (event.occurred_at AT TIME ZONE 'Europe/Moscow')::date THEN RAISE EXCEPTION 'Ownership period does not match its event'; END IF;
  IF p.end_container_owner_history_id IS NOT NULL THEN
   SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=p.end_container_owner_history_id;
   IF p.end_date_exclusive IS DISTINCT FROM ((event.occurred_at AT TIME ZONE 'Europe/Moscow')::date+CASE WHEN event.order_type='SHIPPING_ORDER' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Invalid ownership date boundary'; END IF;
  END IF;
  found_period:=true;previous_end:=p.end_date_exclusive;cursor_date:=p.end_date_exclusive;
 END LOOP;
 IF NOT found_period OR cursor_date IS DISTINCT FROM v.shipping_date+1 THEN RAISE EXCEPTION 'Ownership periods do not cover receiving/shipping: %',v.id; END IF;
END $$;
CREATE FUNCTION validate_container_visit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='container_visit' THEN
  IF TG_OP<>'DELETE' THEN PERFORM check_container_visit(NEW.id); END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN PERFORM check_container_visit(OLD.container_visit_id); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM check_container_visit(NEW.container_visit_id); END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER container_visit_integrity AFTER INSERT OR UPDATE ON container_visit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_visit();
CREATE CONSTRAINT TRIGGER ownership_period_visit_integrity AFTER INSERT OR UPDATE OR DELETE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_visit();

CREATE FUNCTION protect_ownership_period_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership history must be cancelled, not deleted' USING ERRCODE='23514'; END IF;
 IF OLD.record_type='STORAGE' AND (NEW.container_id,NEW.container_visit_id,NEW.client_id,NEW.start_date,NEW.start_container_owner_history_id,NEW.record_type)
  IS DISTINCT FROM (OLD.container_id,OLD.container_visit_id,OLD.client_id,OLD.start_date,OLD.start_container_owner_history_id,OLD.record_type) THEN
  RAISE EXCEPTION 'Storage ownership origin is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER ownership_period_origin_immutable BEFORE UPDATE OR DELETE ON container_ownership_period FOR EACH ROW EXECUTE FUNCTION protect_ownership_period_start();

CREATE FUNCTION validate_container_stock_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record;v container_visit%ROWTYPE; BEGIN
 SELECT * INTO o FROM container_owner_current WHERE container_id=COALESCE(NEW.container_id,OLD.container_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF o.client_id IS NULL THEN RAISE EXCEPTION 'Warehouse state has no ownership assignment'; END IF;
 SELECT * INTO v FROM container_visit WHERE id=o.container_visit_id;
 IF o.status<>'DEPARTED' AND (v.id IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL) THEN RAISE EXCEPTION 'Warehouse state refers to an unavailable receiving'; END IF;
 IF o.status='DEPARTED' AND v.id IS NOT NULL AND (v.is_cancelled OR v.shipping_date IS NULL) THEN RAISE EXCEPTION 'Departed stock refers to an open or cancelled visit'; END IF;
 IF o.status='EXPECTED' AND v.receiving_date IS NOT NULL OR o.status IN ('ON_TERMINAL','RESERVED_OUT') AND v.receiving_date IS NULL THEN RAISE EXCEPTION 'Warehouse state does not match receiving'; END IF;
 IF o.status IN ('EXPECTED','ON_TERMINAL') AND o.shipping_order_id IS NOT NULL OR o.status='RESERVED_OUT' AND o.shipping_order_id IS NULL THEN RAISE EXCEPTION 'Invalid current shipping reservation'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER container_owner_state_integrity AFTER INSERT OR UPDATE ON container_owner DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_stock_state();
CREATE CONSTRAINT TRIGGER ownership_period_stock_integrity AFTER INSERT OR UPDATE OR DELETE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_stock_state();
CREATE CONSTRAINT TRIGGER container_visit_stock_integrity AFTER INSERT OR UPDATE ON container_visit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_stock_state();

CREATE FUNCTION validate_ownership_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p container_ownership_period%ROWTYPE; h container_owner_history_view%ROWTYPE; BEGIN
 SELECT * INTO p FROM container_ownership_period WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=p.start_container_owner_history_id;
 IF p.container_id<>h.container_id OR p.client_id<>h.new_client_id THEN RAISE EXCEPTION 'Ownership assignment does not match its history' USING ERRCODE='23514'; END IF;
 IF p.record_type='EXPECTED' AND h.new_status<>'EXPECTED' OR p.record_type='OUTSIDE_STORAGE' AND h.new_status<>'DEPARTED' THEN RAISE EXCEPTION 'Invalid ownership assignment type' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ownership_assignment_event AFTER INSERT OR UPDATE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ownership_assignment();

-- The observer is optional; only extend an already installed observer, never install one implicitly.
DO $$ BEGIN IF to_regprocedure('billing_observer.notify_change()') IS NOT NULL THEN
 EXECUTE 'CREATE TRIGGER billing_db_viewer_changes AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON container_visit FOR EACH STATEMENT EXECUTE FUNCTION billing_observer.notify_change()';
 EXECUTE 'CREATE TRIGGER billing_db_viewer_changes AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON container_ownership_period FOR EACH STATEMENT EXECUTE FUNCTION billing_observer.notify_change()';
END IF; END $$;


CREATE CONSTRAINT TRIGGER ownership_period_boundary_events AFTER INSERT OR DELETE OR UPDATE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_storage_period_boundaries();
DO $$ DECLARE row_id uuid; BEGIN
 IF EXISTS((SELECT id,container_id,start_history_id,end_history_id,status,created_at,updated_at FROM visit_migration_periods EXCEPT ALL SELECT * FROM container_storage_period)
 UNION ALL (SELECT * FROM container_storage_period EXCEPT ALL SELECT id,container_id,start_history_id,end_history_id,status,created_at,updated_at FROM visit_migration_periods)) THEN RAISE EXCEPTION 'Storage migration changed existing periods'; END IF;
 IF EXISTS((TABLE visit_migration_report EXCEPT ALL TABLE container_storage_period_view) UNION ALL (TABLE container_storage_period_view EXCEPT ALL TABLE visit_migration_report)) THEN RAISE EXCEPTION 'Storage migration changed the report'; END IF;
 FOR row_id IN SELECT id FROM container_visit LOOP PERFORM check_container_visit(row_id); END LOOP;
 FOR row_id IN SELECT id FROM container_storage_period LOOP PERFORM check_storage_period_boundaries(row_id); END LOOP;
END $$;
