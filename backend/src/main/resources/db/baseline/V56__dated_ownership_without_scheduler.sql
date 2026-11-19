-- Ownership is a dated ledger. Confirmation writes once; dates and reads never execute jobs.
CREATE TEMP TABLE dated_before_periods ON COMMIT DROP AS SELECT * FROM container_storage_period;
CREATE TEMP TABLE dated_before_report ON COMMIT DROP AS SELECT * FROM container_storage_period_view;
CREATE TEMP TABLE dated_before_owners ON COMMIT DROP AS SELECT container_id,client_id FROM container_owner_current;
DROP TRIGGER ownership_period_boundary_events ON container_ownership_period;
DROP TRIGGER ownership_period_visit_integrity ON container_ownership_period;
DROP TRIGGER ownership_period_stock_integrity ON container_ownership_period;
DROP TRIGGER ownership_assignment_event ON container_ownership_period;
DROP TRIGGER ownership_period_origin_immutable ON container_ownership_period;
DROP VIEW container_storage_period_view;
DROP VIEW container_storage_period_origin;
DROP VIEW container_storage_period;
DROP INDEX ownership_period_one_open;
DROP INDEX ownership_period_one_expected;
ALTER TABLE container_ownership_period DROP CONSTRAINT container_ownership_period_check;
ALTER TABLE container_ownership_period DROP COLUMN end_date_exclusive,DROP COLUMN end_container_owner_history_id;
ALTER TABLE container_ownership_period ADD COLUMN effective_date date,
 ADD COLUMN is_withdrawn boolean NOT NULL DEFAULT false,ADD COLUMN withdrawn_at timestamptz,ADD COLUMN withdrawal_reason text;
UPDATE container_ownership_period p SET effective_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date FROM container_owner_history h WHERE h.id=p.start_container_owner_history_id;
ALTER TABLE container_ownership_period ALTER COLUMN effective_date SET NOT NULL;
ALTER TABLE container_ownership_period ADD CONSTRAINT ownership_storage_start CHECK((record_type='STORAGE' AND start_date IS NOT NULL AND start_date=effective_date) OR (record_type<>'STORAGE' AND start_date IS NULL)),
 ADD CONSTRAINT ownership_withdrawal CHECK(is_withdrawn=(withdrawn_at IS NOT NULL));
CREATE INDEX ownership_effective_date ON container_ownership_period(container_id,effective_date DESC) WHERE NOT is_cancelled AND NOT is_withdrawn;

-- Older EXPECTED assignments were overwritten on receiving/transfer. Recover their recorded dates,
-- without changing existing periods or history. These assignments never add historical storage days.
INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id,
 effective_date,is_cancelled,cancellation_container_owner_history_id,created_at,updated_at)
 SELECT gen_random_uuid(),h.container_id,v.id,h.new_client_id,'EXPECTED',h.id,(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,
 coalesce(v.is_cancelled,false),v.cancellation_container_owner_history_id,h.occurred_at,h.occurred_at
 FROM container_owner_history_view h
 JOIN LATERAL(SELECT r.order_id FROM container_owner_history_view r WHERE r.container_id=h.container_id AND r.operation_type='RESERVE_RECEIVING' AND r.created_at<=h.created_at ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true
 JOIN container_visit v ON v.container_id=h.container_id AND v.receiving_order_id=r.order_id
 WHERE h.new_status='EXPECTED' AND h.operation_type IN ('RESERVE_RECEIVING','OWNER_CHANGE')
 AND NOT EXISTS(SELECT 1 FROM container_ownership_period p WHERE p.start_container_owner_history_id=h.id);

CREATE VIEW container_storage_period AS
 WITH eligible AS (
  SELECT p.*,h.created_at AS recorded,v.shipping_container_owner_history_id,
   lead(p.start_container_owner_history_id) OVER(PARTITION BY p.container_visit_id ORDER BY p.effective_date,h.occurred_at,h.created_at,h.id) AS next_history_id
  FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id
  JOIN container_owner_history_view h ON h.id=p.start_container_owner_history_id
  JOIN container_owner_history a ON a.id=v.receiving_container_owner_history_id
  WHERE NOT p.is_withdrawn AND (p.record_type='STORAGE' OR
   (p.record_type='EXPECTED' AND h.operation_type='OWNER_CHANGE' AND h.occurred_at>=a.occurred_at))
 ) SELECT id,container_id,start_container_owner_history_id AS start_history_id,
  coalesce(next_history_id,shipping_container_owner_history_id) AS end_history_id,
  (CASE WHEN is_cancelled THEN 'CANCELLED' WHEN coalesce(next_history_id,shipping_container_owner_history_id) IS NULL THEN 'OPEN' ELSE 'CLOSED' END)::varchar(20) AS status,created_at,updated_at
 FROM eligible;
CREATE VIEW container_storage_period_origin AS
 SELECT p.id,p.container_id,v.receiving_order_id,v.receiving_container_owner_history_id AS arrival_history_id
 FROM container_storage_period p JOIN container_ownership_period op ON op.id=p.id JOIN container_visit v ON v.id=op.container_visit_id;
CREATE OR REPLACE FUNCTION storage_arrival_history(period_id uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE result uuid; BEGIN SELECT v.receiving_container_owner_history_id INTO STRICT result FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id WHERE p.id=period_id;RETURN result;END $$;
CREATE OR REPLACE FUNCTION storage_receiving_order(period_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT v.receiving_order_id FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id WHERE p.id=period_id
$$;
CREATE FUNCTION container_storage_period_at(report_date date) RETURNS SETOF container_storage_period LANGUAGE sql STABLE AS $$
 SELECT p.id,p.container_id,p.start_history_id,
  CASE WHEN (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN p.end_history_id END,
  (CASE WHEN p.status='CANCELLED' THEN 'CANCELLED' WHEN (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN 'CLOSED' ELSE 'OPEN' END)::varchar(20),p.created_at,p.updated_at
 FROM container_storage_period p JOIN container_owner_history a ON a.id=p.start_history_id LEFT JOIN container_owner_history e ON e.id=p.end_history_id
 WHERE (a.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=report_date
$$;
CREATE OR REPLACE VIEW container_owner_current AS
 SELECT o.*,v.receiving_order_id,p.client_id FROM container_owner o LEFT JOIN container_visit v ON v.id=o.container_visit_id
 LEFT JOIN LATERAL(SELECT p.client_id FROM container_ownership_period p JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
   WHERE p.container_id=o.container_id AND NOT p.is_cancelled AND NOT p.is_withdrawn AND p.effective_date<=billing_today()
   ORDER BY p.effective_date DESC,h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1) p ON true;

ALTER TABLE service_order_container ADD COLUMN container_ownership_period_id uuid REFERENCES container_ownership_period(id);
UPDATE service_order_container sc SET container_ownership_period_id=p.id FROM container_ownership_period p JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
 WHERE h.order_type='SERVICE_ORDER' AND h.order_id=sc.service_order_id AND h.container_id=sc.container_id;
ALTER TABLE service_order DROP CONSTRAINT service_order_status_check;
ALTER TABLE service_order ADD CONSTRAINT service_order_status_check CHECK(status IN ('DRAFT','SCHEDULED','CONFIRMED','DONE','PARTIAL','CANCELLED'));
ALTER TABLE service_order_container DROP CONSTRAINT service_order_container_result_status_check;
ALTER TABLE service_order_container ADD CONSTRAINT service_order_container_result_status_check CHECK(result_status IN ('DRAFT','PLANNED','CONFIRMED','APPLIED','SKIPPED','CANCELLED','BLOCKED'));
CREATE VIEW service_order_container_current AS
 SELECT sc.id,sc.service_order_id,sc.container_id,sc.container_visit_id,sc.expected_client_id,sc.expected_status,
 (CASE WHEN sc.result_status='CONFIRMED' THEN CASE WHEN p.is_withdrawn OR p.is_cancelled THEN 'CANCELLED' WHEN p.effective_date>billing_today() THEN 'PLANNED' ELSE 'APPLIED' END ELSE sc.result_status END)::varchar(20) AS result_status,
 sc.result_reason,sc.container_ownership_period_id FROM service_order_container sc LEFT JOIN container_ownership_period p ON p.id=sc.container_ownership_period_id;
CREATE VIEW service_order_current AS
 SELECT s.id,s.number,s.client_id,s.service,s.comment,
 (CASE WHEN s.status='CONFIRMED' THEN CASE WHEN x.pending>0 THEN 'SCHEDULED' WHEN x.applied=0 THEN 'CANCELLED' WHEN x.applied=x.total THEN 'DONE' ELSE 'PARTIAL' END ELSE s.status END)::varchar(20) AS status,
 s.completion_at,s.created_at,s.created_by,s.updated_at,s.updated_by,s.effective_date
 FROM service_order s LEFT JOIN LATERAL(SELECT count(*) AS total,count(*) FILTER(WHERE result_status='PLANNED') AS pending,count(*) FILTER(WHERE result_status='APPLIED') AS applied FROM service_order_container_current sc WHERE sc.service_order_id=s.id)x ON true;

CREATE FUNCTION set_ownership_effective_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date INTO NEW.effective_date FROM container_owner_history WHERE id=NEW.start_container_owner_history_id;
 RETURN NEW;
END $$;
CREATE TRIGGER ownership_effective_date BEFORE INSERT ON container_ownership_period FOR EACH ROW EXECUTE FUNCTION set_ownership_effective_date();

CREATE FUNCTION withdraw_ownership_period(period_id uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p container_ownership_period%ROWTYPE;v container_visit%ROWTYPE;BEGIN
 SELECT * INTO STRICT p FROM container_ownership_period WHERE id=period_id;
 IF p.is_withdrawn THEN RETURN; END IF;
 IF p.effective_date<=billing_today() THEN RAISE EXCEPTION 'Нельзя отозвать передачу с наступившей датой' USING ERRCODE='23514'; END IF;
 SELECT * INTO v FROM container_visit WHERE id=p.container_visit_id;
 IF v.shipping_date>=p.effective_date OR EXISTS(SELECT 1 FROM container_ownership_period next JOIN container_owner_history h ON h.id=next.start_container_owner_history_id JOIN container_owner_history old ON old.id=p.start_container_owner_history_id
  WHERE next.container_id=p.container_id AND NOT next.is_cancelled AND NOT next.is_withdrawn AND next.id<>p.id AND (next.effective_date,h.occurred_at,h.created_at)>(p.effective_date,old.occurred_at,old.created_at)) THEN
  RAISE EXCEPTION 'Сначала отмените последующие операции КТК' USING ERRCODE='23514';
 END IF;
 UPDATE container_ownership_period SET is_withdrawn=true,withdrawn_at=billing_now(),withdrawal_reason=reason,updated_at=billing_now() WHERE id=p.id;
END $$;
CREATE FUNCTION revoke_future_ownership(physical_container uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;BEGIN
 FOR p IN SELECT op.id FROM container_ownership_period op JOIN container_owner_history h ON h.id=op.start_container_owner_history_id
  WHERE op.container_id=physical_container AND op.effective_date>billing_today() AND h.order_type='SERVICE_ORDER' AND NOT op.is_withdrawn AND NOT op.is_cancelled ORDER BY op.effective_date DESC,h.occurred_at DESC,h.created_at DESC LOOP
  PERFORM withdraw_ownership_period(p.id,reason);
  UPDATE service_order_container SET result_status='SKIPPED',result_reason=reason WHERE container_ownership_period_id=p.id;
 END LOOP;
END $$;

COMMENT ON TABLE container_ownership_period IS 'Датированные назначения собственника. effective_date задаёт начало; конец вычисляется по следующему назначению и shipping. Состояние OPEN/CLOSED не хранится.';
COMMENT ON COLUMN container_ownership_period.effective_date IS 'Дата начала владения по Europe/Moscow. Будущая запись уже сохранена, но до этой даты не определяет текущего собственника и не входит в отчёт.';
COMMENT ON COLUMN container_ownership_period.is_withdrawn IS 'Будущая передача отозвана или прекращена до даты действия; запись остаётся для аудита и исключается из расчёта.';

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
   FROM (((((((((((((((((((((public.container_storage_period_at(public.billing_today()) p
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
  WHERE ((p.status)::text = ANY (ARRAY[('OPEN'::character varying)::text, ('CLOSED'::character varying)::text]));

CREATE OR REPLACE FUNCTION public.apply_container_history(history_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE h container_owner_history_view%ROWTYPE; v container_visit%ROWTYPE; p container_ownership_period%ROWTYPE;
 row_id uuid; rail_id uuid; count_rows integer; result_id uuid; previous_receiving uuid; latest timestamptz;
BEGIN
 SELECT * INTO STRICT h FROM container_owner_history_view WHERE id=history_id;
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit cv ON cv.id=o.container_visit_id WHERE o.container_id=h.container_id;
 IF h.operation_type IN ('RESERVE_RECEIVING','DEPARTURE','CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION','CANCEL_DEPARTURE') THEN
  PERFORM revoke_future_ownership(h.container_id,'Исходный receiving завершён, отменён или заменён; будущая передача прекращена');
 END IF;
 SELECT op.* INTO p FROM container_ownership_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history sh ON sh.id=sp.start_history_id
 WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND op.effective_date<=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date
 ORDER BY op.effective_date DESC,sh.occurred_at DESC,sh.created_at DESC LIMIT 1;
 IF h.operation_type IN ('OWNER_CHANGE','DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT max(occurred_at) INTO latest FROM container_owner_history_view WHERE container_id=h.container_id AND id<>h.id AND (order_type<>'SERVICE_ORDER' OR
 (occurred_at<=h.occurred_at AND NOT EXISTS(SELECT 1 FROM container_ownership_period op WHERE op.start_container_owner_history_id=container_owner_history_view.id AND op.is_withdrawn)));
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
  result_id:=gen_random_uuid();
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
   VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
 ELSIF h.operation_type='OWNER_CHANGE' THEN
  IF h.new_status IN ('ON_TERMINAL','RESERVED_OUT') THEN
   IF p.id IS NULL THEN RAISE EXCEPTION 'Open ownership period is missing' USING ERRCODE='23514'; END IF;
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id)
    VALUES(result_id,h.container_id,v.id,h.new_client_id,'STORAGE',(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,h.id);
  ELSIF h.new_status='EXPECTED' THEN
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id)
    VALUES(result_id,h.container_id,v.id,h.new_client_id,'EXPECTED',h.id);
  ELSE
   result_id:=gen_random_uuid();
   INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id)
    VALUES(result_id,h.container_id,h.new_client_id,'OUTSIDE_STORAGE',h.id);
  END IF;
 ELSIF h.operation_type='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  SELECT count(*),(array_agg(id))[1] INTO count_rows,row_id FROM shipping_order_container WHERE shipping_order_id=h.order_id AND container_id=h.container_id AND status='FINISHED';
  IF count_rows<>1 THEN RAISE EXCEPTION 'Shipping requires exactly one finished row' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_date=(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date,shipping_order_container_id=row_id,
   shipping_container_owner_history_id=h.id,updated_at=billing_now() WHERE id=v.id;
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
  SELECT op.* INTO p FROM container_ownership_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history e ON e.id=sp.end_history_id
   WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND e.order_type='SHIPPING_ORDER' AND e.order_id=h.order_id;
  IF p.id IS NULL OR v.is_cancelled OR v.shipping_date IS NULL THEN RAISE EXCEPTION 'Shipping cancellation cycle is not closed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM container_owner_history_view e JOIN container_owner_history shipping ON shipping.id=v.shipping_container_owner_history_id
   WHERE e.container_id=h.container_id AND e.operation_type='OWNER_CHANGE' AND e.new_status='DEPARTED' AND e.created_at>shipping.created_at AND (e.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today() AND NOT EXISTS(SELECT 1 FROM container_ownership_period removed WHERE removed.start_container_owner_history_id=e.id AND removed.is_withdrawn)) THEN
   RAISE EXCEPTION 'Нельзя отменить shipping после смены собственника вне площадки' USING ERRCODE='23514';
  END IF;
  UPDATE container_visit SET shipping_date=NULL,shipping_order_container_id=NULL,shipping_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id;
  result_id:=p.id;
 ELSE
  result_id:=p.id;
  IF h.operation_type='CANCEL_SHIPPING_RESERVATION' THEN UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=h.container_id; END IF;
 END IF;
 UPDATE container_owner_history SET storage_period_id=result_id WHERE id=h.id;
END $$;
CREATE OR REPLACE FUNCTION public.check_storage_period_boundaries(period_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
   OR a.old_status NOT IN ('EXPECTED','ON_TERMINAL','RESERVED_OUT') OR a.new_status<>a.old_status
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
CREATE OR REPLACE FUNCTION public.check_container_visit(visit_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
  IF (SELECT count(*) FROM container_ownership_period WHERE container_visit_id=v.id AND record_type='EXPECTED' AND NOT is_cancelled AND NOT is_withdrawn)<1 THEN RAISE EXCEPTION 'Expected receiving requires one owner'; END IF;
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
 FOR p IN SELECT op.*,sp.end_history_id AS derived_end,op.effective_date AS derived_start,h.created_at AS recorded FROM container_ownership_period op JOIN container_storage_period sp ON sp.id=op.id JOIN container_owner_history h ON h.id=op.start_container_owner_history_id
  WHERE op.container_visit_id=v.id AND NOT op.is_cancelled ORDER BY op.effective_date,h.occurred_at,h.created_at,h.id LOOP
  IF p.derived_start IS DISTINCT FROM cursor_date OR (found_period AND previous_end IS NULL) THEN RAISE EXCEPTION 'Ownership periods overlap or have gaps: %',v.id; END IF;
  PERFORM check_storage_period_boundaries(p.id);
  SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=p.start_container_owner_history_id;
  IF p.client_id<>event.new_client_id OR p.derived_start IS DISTINCT FROM (event.occurred_at AT TIME ZONE 'Europe/Moscow')::date THEN RAISE EXCEPTION 'Ownership period does not match its event'; END IF;
  cursor_date:=NULL;
  IF p.derived_end IS NOT NULL THEN
   SELECT * INTO STRICT event FROM container_owner_history_view WHERE id=p.derived_end;
   cursor_date:=(event.occurred_at AT TIME ZONE 'Europe/Moscow')::date+CASE WHEN event.order_type='SHIPPING_ORDER' THEN 1 ELSE 0 END;
  END IF;
  found_period:=true;previous_end:=cursor_date;
 END LOOP;
 IF NOT found_period OR cursor_date IS DISTINCT FROM v.shipping_date+1 THEN RAISE EXCEPTION 'Ownership periods do not cover receiving/shipping: %',v.id; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.protect_ownership_period_start() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership history must be cancelled, not deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.container_id,NEW.container_visit_id,NEW.client_id,NEW.start_date,NEW.start_container_owner_history_id,NEW.record_type,NEW.effective_date)
  IS DISTINCT FROM (OLD.container_id,OLD.container_visit_id,OLD.client_id,OLD.start_date,OLD.start_container_owner_history_id,OLD.record_type,OLD.effective_date) THEN
  RAISE EXCEPTION 'Storage ownership origin is immutable' USING ERRCODE='23514';
 END IF;
 IF NOT OLD.is_withdrawn AND NEW.is_withdrawn AND OLD.effective_date<=billing_today() THEN RAISE EXCEPTION 'Наступившая передача не может быть отозвана' USING ERRCODE='23514'; END IF;
 IF OLD.is_withdrawn AND NOT NEW.is_withdrawn THEN RAISE EXCEPTION 'Отозванная передача не восстанавливается автоматически' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_storage_period_boundaries() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; v record; BEGIN
 cid:=CASE WHEN TG_OP='DELETE' THEN OLD.container_id ELSE NEW.container_id END;
 FOR v IN SELECT id FROM container_visit WHERE container_id=cid LOOP PERFORM check_container_visit(v.id); END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ownership_period_boundary_events AFTER INSERT OR UPDATE OR DELETE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_storage_period_boundaries();
CREATE CONSTRAINT TRIGGER ownership_period_visit_integrity AFTER INSERT OR UPDATE OR DELETE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_visit();
CREATE CONSTRAINT TRIGGER ownership_period_stock_integrity AFTER INSERT OR UPDATE OR DELETE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_container_stock_state();
CREATE CONSTRAINT TRIGGER ownership_assignment_event AFTER INSERT OR UPDATE ON container_ownership_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ownership_assignment();
CREATE TRIGGER ownership_period_origin_immutable BEFORE UPDATE OR DELETE ON container_ownership_period FOR EACH ROW EXECUTE FUNCTION protect_ownership_period_start();


-- Verify old physical intervals before materialising the formerly pending transfers.
DO $$ DECLARE r record; BEGIN
 IF EXISTS((TABLE dated_before_periods EXCEPT ALL TABLE container_storage_period) UNION ALL (TABLE container_storage_period EXCEPT ALL TABLE dated_before_periods)) THEN RAISE EXCEPTION 'Dated ownership changed historical periods'; END IF;
 IF EXISTS(SELECT 1 FROM dated_before_owners b JOIN container_owner_current o USING(container_id) WHERE b.client_id IS DISTINCT FROM o.client_id AND NOT EXISTS(SELECT 1 FROM container_ownership_period p WHERE p.container_id=b.container_id AND NOT p.is_cancelled AND p.effective_date>billing_today())) THEN RAISE EXCEPTION 'Dated ownership changed current owners'; END IF;
 FOR r IN SELECT id FROM container_visit LOOP PERFORM check_container_visit(r.id); END LOOP;
END $$;
-- Existing plans preserve their captured visit/owner and exact accepted effective instant.
DO $$ DECLARE r record; h uuid; p uuid; state record; BEGIN
 FOR r IN SELECT sc.*,s.client_id,s.effective_date,s.updated_at FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id WHERE s.status='SCHEDULED' AND sc.result_status IN ('PLANNED','BLOCKED') ORDER BY s.effective_date,s.id,sc.container_id LOOP
  SELECT * INTO STRICT state FROM container_owner_current WHERE container_id=r.container_id;
  IF state.container_visit_id IS DISTINCT FROM r.container_visit_id OR state.client_id IS DISTINCT FROM r.expected_client_id THEN RAISE EXCEPTION 'Existing ownership plan requires reconciliation: %',r.service_order_id; END IF;
  h:=gen_random_uuid();INSERT INTO container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at)
   VALUES(h,r.container_id,state.client_id,r.client_id,state.status,state.status,r.service_order_id,'SERVICE_ORDER',greatest(r.effective_date::timestamp AT TIME ZONE 'Europe/Moscow',r.updated_at AT TIME ZONE 'UTC'));
  PERFORM apply_container_history(h);
  SELECT id INTO STRICT p FROM container_ownership_period WHERE start_container_owner_history_id=h;
  UPDATE service_order_container SET result_status='CONFIRMED',container_ownership_period_id=p,result_reason=NULL WHERE id=r.id;
 END LOOP;
 UPDATE service_order SET status='CONFIRMED',completion_at=coalesce(completion_at,updated_at) WHERE status='SCHEDULED';
END $$;
ALTER TABLE service_order DROP CONSTRAINT service_order_status_check;
ALTER TABLE service_order ADD CONSTRAINT service_order_status_check CHECK(status IN ('DRAFT','CONFIRMED','DONE','PARTIAL','CANCELLED'));
