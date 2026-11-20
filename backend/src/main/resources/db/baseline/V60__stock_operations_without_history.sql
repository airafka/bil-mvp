-- Primary stock facts drive operations; the event journal is append-only output.
CREATE TEMP TABLE stock_v60_owners ON COMMIT DROP AS SELECT container_id,client_id FROM container_owner_current;
CREATE TEMP TABLE stock_v60_report ON COMMIT DROP AS SELECT * FROM container_storage_report_at(billing_today());

ALTER TABLE container_owner ADD COLUMN last_stock_at timestamptz,ADD COLUMN last_recorded_at timestamp;
ALTER TABLE container_visit ADD COLUMN reserved_at timestamptz,ADD COLUMN reserved_recorded_at timestamp,
 ADD COLUMN previous_client_id uuid REFERENCES client(id),ADD COLUMN shipping_recorded_at timestamp;
UPDATE container_owner o SET last_stock_at=h.last_stock_at,last_recorded_at=h.last_recorded_at
 FROM (SELECT container_id,max(occurred_at) FILTER(WHERE order_type<>'SERVICE_ORDER') last_stock_at,max(created_at) last_recorded_at
 FROM container_owner_history GROUP BY container_id) h WHERE h.container_id=o.container_id;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM container_visit v LEFT JOIN container_owner_history_view h ON h.container_id=v.container_id
  AND h.order_id=v.receiving_order_id AND h.operation_type='RESERVE_RECEIVING' GROUP BY v.id HAVING count(h.id)<>1) THEN
  RAISE EXCEPTION 'Receiving reservations require reconciliation before V60'; END IF;
END $$;
UPDATE container_visit v SET reserved_at=h.occurred_at,reserved_recorded_at=h.created_at,previous_client_id=h.old_client_id
 FROM container_owner_history_view h WHERE h.container_id=v.container_id AND h.order_id=v.receiving_order_id AND h.operation_type='RESERVE_RECEIVING';
UPDATE container_visit v SET shipping_recorded_at=h.created_at FROM container_owner_history h WHERE h.id=v.shipping_container_owner_history_id;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE container_visit ALTER COLUMN reserved_at SET NOT NULL,ALTER COLUMN reserved_recorded_at SET NOT NULL,
 ADD CONSTRAINT visit_shipping_recorded CHECK((shipping_at IS NULL)=(shipping_recorded_at IS NULL));
CREATE UNIQUE INDEX visit_reservation_order ON container_visit(container_id,reserved_recorded_at);

-- Journal references are retained as audit identifiers, not prerequisites for primary writes.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conrelid::regclass AS tab,conname FROM pg_constraint WHERE contype='f' AND confrelid='container_owner_history'::regclass
  AND conrelid IN ('container_visit'::regclass,'container_ownership_period'::regclass) LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tab,c.conname);
 END LOOP;
END $$;
DROP TRIGGER ownership_effective_date ON container_ownership_period;
DROP TRIGGER ownership_report_facts ON container_ownership_period;
DROP TRIGGER visit_report_facts ON container_visit;
DROP TRIGGER stock_history_recorded_at ON container_owner_history;
DROP TRIGGER storage_history_boundary_events ON container_owner_history;
DROP TRIGGER storage_boundary_immutable ON container_owner_history;
DROP FUNCTION set_ownership_effective_date();
DROP FUNCTION capture_ownership_report_facts();
DROP FUNCTION capture_visit_report_facts();
DROP FUNCTION assign_stock_history_recorded_at();
DROP FUNCTION protect_storage_boundary_event();
DROP FUNCTION apply_container_history(uuid);
DROP FUNCTION previous_stock_order(uuid,uuid,character varying);

CREATE FUNCTION next_stock_recorded_at(physical_container uuid) RETURNS timestamp LANGUAGE plpgsql AS $$
DECLARE result timestamp; BEGIN
 UPDATE container_owner SET last_recorded_at=greatest(clock_timestamp() AT TIME ZONE 'UTC',last_recorded_at+interval '1 microsecond')
 WHERE container_id=physical_container RETURNING last_recorded_at INTO STRICT result;
 RETURN result;
END $$;

CREATE FUNCTION previous_container_visit(physical_container uuid,receiving uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT v.id FROM container_visit v JOIN receiving_order r ON r.id=v.receiving_order_id
 WHERE v.container_id=physical_container AND NOT v.is_cancelled AND r.order_status<>'CANCELLED'
 AND v.reserved_recorded_at<(SELECT reserved_recorded_at FROM container_visit WHERE container_id=physical_container AND receiving_order_id=receiving)
 ORDER BY v.reserved_recorded_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION withdraw_ownership_period(period_id uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p container_ownership_period%ROWTYPE;v container_visit%ROWTYPE;BEGIN
 SELECT * INTO STRICT p FROM container_ownership_period WHERE id=period_id;
 IF p.is_withdrawn THEN RETURN; END IF;
 IF p.effective_date<=billing_today() THEN RAISE EXCEPTION 'Нельзя отозвать передачу с наступившей датой' USING ERRCODE='23514'; END IF;
 SELECT * INTO v FROM container_visit WHERE id=p.container_visit_id;
 IF v.shipping_date>=p.effective_date OR EXISTS(SELECT 1 FROM container_ownership_period n
  WHERE n.container_id=p.container_id AND NOT n.is_cancelled AND NOT n.is_withdrawn AND n.id<>p.id
  AND (n.effective_date,n.effective_at,n.recorded_at)>(p.effective_date,p.effective_at,p.recorded_at)) THEN
  RAISE EXCEPTION 'Сначала отмените последующие операции КТК' USING ERRCODE='23514'; END IF;
 UPDATE container_ownership_period SET is_withdrawn=true,withdrawn_at=billing_now(),withdrawal_reason=reason,updated_at=billing_now() WHERE id=p.id;
END $$;
CREATE OR REPLACE FUNCTION revoke_future_ownership(physical_container uuid,reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;BEGIN
 FOR p IN SELECT id FROM container_ownership_period WHERE container_id=physical_container AND effective_date>billing_today()
  AND service_order_id IS NOT NULL AND NOT is_withdrawn AND NOT is_cancelled ORDER BY effective_date DESC,effective_at DESC,recorded_at DESC LOOP
  PERFORM withdraw_ownership_period(p.id,reason);
  UPDATE service_order_container SET result_status='SKIPPED',result_reason=reason WHERE container_ownership_period_id=p.id;
 END LOOP;
END $$;

CREATE FUNCTION apply_container_operation(physical_container uuid,previous_client uuid,next_client uuid,
 previous_status varchar,next_status varchar,document_id uuid,document_type varchar,
 operation_at timestamptz,recorded timestamp,audit_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v container_visit%ROWTYPE;p container_ownership_period%ROWTYPE;action text;
 row_id uuid;rail_id uuid;qty integer;result_id uuid;previous_visit uuid;latest timestamptz;
BEGIN
 action:=history_operation_type(document_type,previous_status,next_status);
 SELECT cv.* INTO v FROM container_owner o JOIN container_visit cv ON cv.id=o.container_visit_id WHERE o.container_id=physical_container;
 IF action IN ('RESERVE_RECEIVING','DEPARTURE','CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION','CANCEL_DEPARTURE') THEN
  PERFORM revoke_future_ownership(physical_container,'Исходный receiving завершён, отменён или заменён; будущая передача прекращена');
 END IF;
 SELECT op.* INTO p FROM container_ownership_period op JOIN container_storage_report_at('infinity'::date) sp ON sp.id=op.id
 WHERE op.container_visit_id=v.id AND op.effective_date<=(operation_at AT TIME ZONE 'Europe/Moscow')::date
 ORDER BY op.effective_date DESC,op.effective_at DESC,op.recorded_at DESC LIMIT 1;
 IF action IN ('DEPARTURE','CANCEL_ARRIVAL','CANCEL_DEPARTURE') THEN
  SELECT last_stock_at INTO latest FROM container_owner WHERE container_id=physical_container;
  IF latest>operation_at THEN RAISE EXCEPTION 'Операция не может быть раньше предыдущих событий КТК' USING ERRCODE='23514'; END IF;
 END IF;
 IF action='RESERVE_RECEIVING' THEN
  UPDATE service_order_container SET result_status='SKIPPED',result_reason='Начат новый receiving; прежняя передача не переносится на него'
   WHERE container_id=physical_container AND result_status IN ('PLANNED','BLOCKED');
  IF (SELECT transport_type FROM receiving_order WHERE id=document_id)='VEHICLE' THEN
   SELECT count(*),(array_agg(id))[1] INTO qty,row_id FROM receiving_order_container WHERE receiving_order_id=document_id AND container_id=physical_container;
  ELSE
   SELECT count(*),(array_agg(wc.id))[1] INTO qty,rail_id FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id
    JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=document_id AND wc.container_id=physical_container;
  END IF;
  IF qty<>1 THEN RAISE EXCEPTION 'Receiving requires exactly one container row' USING ERRCODE='23514'; END IF;
  v.id:=gen_random_uuid();
  INSERT INTO container_visit(id,container_id,receiving_order_id,receiving_order_container_id,waybill_container_id,reserved_at,reserved_recorded_at,previous_client_id)
   VALUES(v.id,physical_container,document_id,row_id,rail_id,operation_at,recorded,previous_client);
  UPDATE container_owner SET container_visit_id=v.id,shipping_order_id=NULL WHERE container_id=physical_container;
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_container_owner_history_id,effective_date,effective_at,recorded_at)
   VALUES(gen_random_uuid(),physical_container,v.id,next_client,'EXPECTED',audit_id,(operation_at AT TIME ZONE 'Europe/Moscow')::date,operation_at,recorded);
 ELSIF action='ARRIVAL' THEN
  IF v.id IS NULL OR v.receiving_order_id<>document_id OR v.is_cancelled OR v.receiving_date IS NOT NULL THEN RAISE EXCEPTION 'Receiving cycle is not expected' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET receiving_date=(operation_at AT TIME ZONE 'Europe/Moscow')::date,receiving_at=operation_at,receiving_container_owner_history_id=audit_id,updated_at=billing_now() WHERE id=v.id;
  result_id:=gen_random_uuid();
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id,effective_date,effective_at,recorded_at)
   VALUES(result_id,physical_container,v.id,next_client,'STORAGE',(operation_at AT TIME ZONE 'Europe/Moscow')::date,audit_id,(operation_at AT TIME ZONE 'Europe/Moscow')::date,operation_at,recorded);
 ELSIF action='OWNER_CHANGE' THEN
  IF next_status NOT IN ('ON_TERMINAL','RESERVED_OUT') OR v.receiving_date IS NULL OR v.is_cancelled OR v.shipping_date IS NOT NULL
   OR v.receiving_date>(operation_at AT TIME ZONE 'Europe/Moscow')::date OR v.receiving_date>billing_today() THEN
   RAISE EXCEPTION 'КТК должен находиться в остатках, дата передачи не раньше receiving текущего визита' USING ERRCODE='23514'; END IF;
  IF p.id IS NULL OR p.client_id IS DISTINCT FROM previous_client THEN RAISE EXCEPTION 'Прежний собственник не соответствует дате передачи' USING ERRCODE='23514'; END IF;
  result_id:=gen_random_uuid();
  INSERT INTO container_ownership_period(id,container_id,container_visit_id,client_id,record_type,start_date,start_container_owner_history_id,effective_date,effective_at,recorded_at,service_order_id)
   VALUES(result_id,physical_container,v.id,next_client,'STORAGE',(operation_at AT TIME ZONE 'Europe/Moscow')::date,audit_id,(operation_at AT TIME ZONE 'Europe/Moscow')::date,operation_at,recorded,document_id);
 ELSIF action='DEPARTURE' THEN
  IF p.id IS NULL THEN RAISE EXCEPTION 'Open storage is missing for shipping' USING ERRCODE='23514'; END IF;
  SELECT count(*),(array_agg(id))[1] INTO qty,row_id FROM shipping_order_container WHERE shipping_order_id=document_id AND container_id=physical_container AND status='FINISHED';
  IF qty<>1 THEN RAISE EXCEPTION 'Shipping requires exactly one finished row' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_date=(operation_at AT TIME ZONE 'Europe/Moscow')::date,shipping_at=operation_at,shipping_recorded_at=recorded,
   shipping_order_container_id=row_id,shipping_container_owner_history_id=audit_id,updated_at=billing_now() WHERE id=v.id;
  result_id:=p.id;
  UPDATE service_order_container SET result_status='SKIPPED',result_reason='КТК вывезен до исполнения передачи; план не переносится на новый receiving'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
 ELSIF action IN ('CANCEL_ARRIVAL','CANCEL_RECEIVING_RESERVATION') THEN
  IF v.id IS NULL OR v.receiving_order_id<>document_id THEN RAISE EXCEPTION 'Wrong receiving cancellation cycle' USING ERRCODE='23514'; END IF;
  result_id:=p.id;previous_visit:=previous_container_visit(physical_container,document_id);
  UPDATE container_visit SET is_cancelled=true,cancellation_container_owner_history_id=audit_id,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_ownership_period SET is_cancelled=true,cancellation_container_owner_history_id=audit_id,updated_at=billing_now() WHERE container_visit_id=v.id;
  UPDATE service_order_container SET result_status='CANCELLED',result_reason='Receiving отменён; передача не исполняется'
   WHERE container_visit_id=v.id AND result_status IN ('PLANNED','BLOCKED');
  UPDATE container_owner SET container_visit_id=previous_visit,
   shipping_order_id=(SELECT sc.shipping_order_id FROM container_visit cv JOIN shipping_order_container sc ON sc.id=cv.shipping_order_container_id WHERE cv.id=previous_visit)
   WHERE container_id=physical_container;
  INSERT INTO container_ownership_period(id,container_id,client_id,record_type,start_container_owner_history_id,effective_date,effective_at,recorded_at)
   VALUES(gen_random_uuid(),physical_container,next_client,'OUTSIDE_STORAGE',audit_id,(operation_at AT TIME ZONE 'Europe/Moscow')::date,operation_at,recorded);
 ELSIF action='CANCEL_DEPARTURE' THEN
  IF p.id IS NULL OR v.is_cancelled OR v.shipping_date IS NULL OR NOT EXISTS(SELECT 1 FROM shipping_order_container WHERE id=v.shipping_order_container_id AND shipping_order_id=document_id) THEN
   RAISE EXCEPTION 'Shipping cancellation cycle is not closed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM container_ownership_period op WHERE op.container_id=physical_container AND op.record_type='OUTSIDE_STORAGE'
   AND op.service_order_id IS NOT NULL AND op.recorded_at>v.shipping_recorded_at AND op.effective_date<=billing_today() AND NOT op.is_withdrawn) THEN
   RAISE EXCEPTION 'Нельзя отменить shipping после смены собственника вне площадки' USING ERRCODE='23514'; END IF;
  UPDATE container_visit SET shipping_date=NULL,shipping_at=NULL,shipping_recorded_at=NULL,shipping_order_container_id=NULL,shipping_container_owner_history_id=NULL,updated_at=billing_now() WHERE id=v.id;
  UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=physical_container;
  result_id:=p.id;
 ELSE
  result_id:=p.id;
  IF action='CANCEL_SHIPPING_RESERVATION' THEN UPDATE container_owner SET shipping_order_id=NULL WHERE container_id=physical_container; END IF;
 END IF;
 IF document_type<>'SERVICE_ORDER' THEN UPDATE container_owner SET last_stock_at=greatest(last_stock_at,operation_at) WHERE container_id=physical_container; END IF;
 RETURN result_id;
END $$;

CREATE OR REPLACE FUNCTION protect_ownership_period_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership must be cancelled, not deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.container_id,NEW.container_visit_id,NEW.client_id,NEW.start_date,NEW.start_container_owner_history_id,NEW.record_type,NEW.effective_date,NEW.effective_at,NEW.recorded_at,NEW.service_order_id)
  IS DISTINCT FROM (OLD.container_id,OLD.container_visit_id,OLD.client_id,OLD.start_date,OLD.start_container_owner_history_id,OLD.record_type,OLD.effective_date,OLD.effective_at,OLD.recorded_at,OLD.service_order_id) THEN
  RAISE EXCEPTION 'Ownership origin is immutable' USING ERRCODE='23514'; END IF;
 IF NOT OLD.is_withdrawn AND NEW.is_withdrawn AND OLD.effective_date<=billing_today() THEN RAISE EXCEPTION 'Наступившая передача не может быть отозвана' USING ERRCODE='23514'; END IF;
 IF OLD.is_withdrawn AND NOT NEW.is_withdrawn THEN RAISE EXCEPTION 'Отозванная передача не восстанавливается автоматически' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION protect_container_visit_facts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.container_id,NEW.receiving_order_id,NEW.reserved_at,NEW.reserved_recorded_at,NEW.previous_client_id)
  IS DISTINCT FROM (OLD.container_id,OLD.receiving_order_id,OLD.reserved_at,OLD.reserved_recorded_at,OLD.previous_client_id)
  OR (OLD.receiving_at IS NOT NULL AND NEW.receiving_at IS DISTINCT FROM OLD.receiving_at)
  OR (OLD.shipping_at IS NOT NULL AND NEW.shipping_at IS NOT NULL AND (NEW.shipping_at,NEW.shipping_recorded_at,NEW.shipping_order_container_id)
    IS DISTINCT FROM (OLD.shipping_at,OLD.shipping_recorded_at,OLD.shipping_order_container_id)) THEN
  RAISE EXCEPTION 'Visit origin and completed facts are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER visit_facts_immutable BEFORE UPDATE ON container_visit FOR EACH ROW EXECUTE FUNCTION protect_container_visit_facts();
CREATE FUNCTION protect_stock_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Stock journal is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER stock_journal_immutable BEFORE UPDATE OR DELETE ON container_owner_history FOR EACH ROW EXECUTE FUNCTION protect_stock_journal();

CREATE OR REPLACE FUNCTION check_container_visit(visit_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v container_visit%ROWTYPE;r receiving_order%ROWTYPE;s shipping_order%ROWTYPE;p record;
 cursor_at timestamptz;found_period boolean:=false;qty bigint;finished bigint;
BEGIN
 SELECT * INTO v FROM container_visit WHERE id=visit_id;IF NOT FOUND THEN RETURN; END IF;
 IF v.is_cancelled THEN
  IF EXISTS(SELECT 1 FROM container_ownership_period WHERE container_visit_id=v.id AND NOT is_cancelled) THEN RAISE EXCEPTION 'Cancelled receiving has active ownership' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 SELECT * INTO STRICT r FROM receiving_order WHERE id=v.receiving_order_id FOR KEY SHARE;
 IF v.receiving_order_container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM receiving_order_container t WHERE t.id=v.receiving_order_container_id AND t.receiving_order_id=v.receiving_order_id AND t.container_id=v.container_id)
  OR v.waybill_container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM waybill_container wc JOIN waybill_railway_carriage wr ON wr.id=wc.waybill_railway_carriage_id JOIN waybill w ON w.id=wr.waybill_id WHERE wc.id=v.waybill_container_id AND wc.container_id=v.container_id AND w.receiving_order_id=v.receiving_order_id) THEN
  RAISE EXCEPTION 'Receiving row belongs to another visit' USING ERRCODE='23514'; END IF;
 IF v.receiving_at IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM container_ownership_period WHERE container_visit_id=v.id AND record_type='EXPECTED' AND NOT is_cancelled AND NOT is_withdrawn) THEN RAISE EXCEPTION 'Expected receiving requires ownership' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 IF r.transport_type='VEHICLE' THEN
  SELECT count(*),count(*) FILTER(WHERE status='FINISHED') INTO qty,finished FROM receiving_order_container WHERE receiving_order_id=r.id AND container_id=v.container_id;
 ELSE
  SELECT count(*),count(*) FILTER(WHERE wc.status='FINISHED') INTO qty,finished FROM waybill w JOIN waybill_railway_carriage wr ON wr.waybill_id=w.id JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE w.receiving_order_id=r.id AND wc.container_id=v.container_id;
 END IF;
 IF qty<>1 OR finished<>1 OR r.order_status<>'COMPLETED' THEN RAISE EXCEPTION 'Invalid storage receiving source: exactly one finished task required' USING ERRCODE='23514'; END IF;
 IF v.shipping_at IS NOT NULL THEN
  SELECT so.* INTO STRICT s FROM shipping_order_container sc JOIN shipping_order so ON so.id=sc.shipping_order_id WHERE sc.id=v.shipping_order_container_id AND sc.container_id=v.container_id;
  SELECT count(*),count(*) FILTER(WHERE status='FINISHED') INTO qty,finished FROM shipping_order_container WHERE shipping_order_id=s.id AND container_id=v.container_id;
  IF qty<>1 OR finished<>1 OR s.order_status<>'COMPLETED' OR s.terminal_area_catalog_id IS DISTINCT FROM r.terminal_area_catalog_id THEN
   RAISE EXCEPTION 'Invalid storage shipping source: exactly one finished task on the same terminal required' USING ERRCODE='23514'; END IF;
 END IF;
 IF (SELECT count(*) FROM container_ownership_period WHERE container_visit_id=v.id AND record_type='STORAGE' AND service_order_id IS NULL AND NOT is_cancelled AND NOT is_withdrawn)<>1 THEN
  RAISE EXCEPTION 'Visit requires exactly one initial storage assignment' USING ERRCODE='23514'; END IF;
 cursor_at:=v.receiving_at;
 FOR p IN SELECT * FROM container_storage_report_at('infinity'::date) WHERE container_visit_id=v.id ORDER BY start_at,recorded_at LOOP
  IF p.start_at IS DISTINCT FROM cursor_at OR p.end_at<p.start_at OR (NOT found_period AND p.start_order_type<>'RECEIVING_ORDER') THEN
   RAISE EXCEPTION 'Ownership assignments do not cover visit %',v.id USING ERRCODE='23514'; END IF;
  cursor_at:=p.end_at;found_period:=true;
 END LOOP;
 IF NOT found_period OR cursor_at IS DISTINCT FROM v.shipping_at THEN RAISE EXCEPTION 'Ownership assignments do not cover shipping %',v.id USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION check_storage_period_sources(period_id uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM check_container_visit(container_visit_id) FROM container_ownership_period WHERE id=period_id;
END $$;
CREATE OR REPLACE FUNCTION check_storage_period_boundaries(period_id uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM check_container_visit(container_visit_id) FROM container_ownership_period WHERE id=period_id;
END $$;
CREATE OR REPLACE FUNCTION validate_ownership_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p container_ownership_period%ROWTYPE;v container_visit%ROWTYPE;BEGIN
 SELECT * INTO p FROM container_ownership_period WHERE id=NEW.id;IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO v FROM container_visit WHERE id=p.container_visit_id;
 IF p.record_type='STORAGE' AND (v.receiving_at IS NULL OR p.effective_at<v.receiving_at) THEN RAISE EXCEPTION 'Storage starts before receiving' USING ERRCODE='23514'; END IF;
 IF p.service_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM service_order WHERE id=p.service_order_id AND client_id=p.client_id AND service='CHANGE_OWNER') THEN
  RAISE EXCEPTION 'Ownership assignment does not match its document' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION validate_storage_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row jsonb;after_row jsonb;affected uuid[];cid uuid;vid uuid;BEGIN
 before_row:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 IF TG_WHEN='BEFORE' AND TG_TABLE_NAME='receiving_order' AND (TG_OP='DELETE' OR before_row->>'id' IS DISTINCT FROM after_row->>'id')
  AND EXISTS(SELECT 1 FROM container_visit WHERE receiving_order_id=(before_row->>'id')::uuid) THEN
  RAISE EXCEPTION 'Receiving order is referenced by a visit' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME IN ('receiving_order_container','shipping_order_container','waybill_container') THEN
  affected:=ARRAY[(before_row->>'container_id')::uuid,(after_row->>'container_id')::uuid];
 ELSIF TG_TABLE_NAME='waybill' THEN
  SELECT array_agg(DISTINCT wc.container_id) INTO affected FROM waybill_railway_carriage wr JOIN waybill_container wc ON wc.waybill_railway_carriage_id=wr.id WHERE wr.waybill_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid);
 ELSIF TG_TABLE_NAME='waybill_railway_carriage' THEN
  SELECT array_agg(DISTINCT container_id) INTO affected FROM waybill_container WHERE waybill_railway_carriage_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid);
 ELSIF TG_TABLE_NAME='receiving_order' THEN
  SELECT array_agg(DISTINCT container_id) INTO affected FROM container_visit WHERE receiving_order_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid) AND NOT is_cancelled;
 ELSE
  SELECT array_agg(DISTINCT v.container_id) INTO affected FROM container_visit v JOIN shipping_order_container sc ON sc.id=v.shipping_order_container_id WHERE sc.shipping_order_id IN ((before_row->>'id')::uuid,(after_row->>'id')::uuid) AND NOT v.is_cancelled;
 END IF;
 FOR cid IN SELECT DISTINCT x FROM unnest(affected) x WHERE x IS NOT NULL ORDER BY x LOOP
  IF TG_WHEN='BEFORE' THEN PERFORM 1 FROM container WHERE id=cid FOR UPDATE;
  ELSE FOR vid IN SELECT id FROM container_visit WHERE container_id=cid AND NOT is_cancelled LOOP PERFORM check_container_visit(vid); END LOOP;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;

CREATE OR REPLACE VIEW container_owner_current AS SELECT o."id",o."container_id",o."status",o."shipping_order_id",o."created_at",o."created_by",o."updated_at",o."updated_by",o."container_visit_id",o."version",v.receiving_order_id,p.client_id FROM container_owner o LEFT JOIN container_visit v ON v.id=o.container_visit_id
 LEFT JOIN LATERAL(SELECT p.client_id FROM container_ownership_period p
 WHERE p.container_id=o.container_id AND NOT p.is_cancelled AND NOT p.is_withdrawn AND p.effective_date<=billing_today()
 ORDER BY p.effective_date DESC,p.effective_at DESC,p.recorded_at DESC LIMIT 1)p ON true;
CREATE OR REPLACE FUNCTION public.ownership_transfer_candidates(transfer_date date, target_client uuid, own_order uuid)
 RETURNS TABLE(owner_id uuid, container_id uuid, container_visit_id uuid, previous_client_id uuid, transfer_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
 SELECT o.id,o.container_id,v.id,p.client_id,
 greatest(transfer_date::timestamp AT TIME ZONE 'Europe/Moscow',
   CASE WHEN p.effective_date=transfer_date THEN p.effective_at+interval '1 microsecond' END,
   CASE WHEN transfer_date=billing_today() THEN billing_now() END)
 FROM container_owner o JOIN container_visit v ON v.id=o.container_visit_id
 JOIN LATERAL(SELECT op.client_id,op.effective_date,op.effective_at
   FROM container_ownership_period op
   WHERE op.container_visit_id=v.id AND NOT op.is_cancelled AND NOT op.is_withdrawn AND op.effective_date<=transfer_date
   ORDER BY op.effective_date DESC,op.effective_at DESC,op.recorded_at DESC LIMIT 1)p ON true
 WHERE o.status IN ('ON_TERMINAL','RESERVED_OUT') AND NOT v.is_cancelled AND v.shipping_date IS NULL
   AND v.receiving_date<=transfer_date AND v.receiving_date<=billing_today() AND p.client_id<>target_client
   AND NOT EXISTS(SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id=sc.service_order_id
     WHERE sc.container_id=o.container_id AND s.status='DRAFT' AND s.id IS DISTINCT FROM own_order)
$function$
;
DO $$ DECLARE v record;BEGIN
 FOR v IN SELECT id FROM container_visit LOOP PERFORM check_container_visit(v.id);END LOOP;
 IF EXISTS((SELECT * FROM stock_v60_report EXCEPT ALL SELECT * FROM container_storage_report_at(billing_today())) UNION ALL
 (SELECT * FROM container_storage_report_at(billing_today()) EXCEPT ALL SELECT * FROM stock_v60_report)) THEN RAISE EXCEPTION 'V60 changed storage report'; END IF;
 IF EXISTS((SELECT * FROM stock_v60_owners EXCEPT ALL SELECT container_id,client_id FROM container_owner_current) UNION ALL
 (SELECT container_id,client_id FROM container_owner_current EXCEPT ALL SELECT * FROM stock_v60_owners)) THEN RAISE EXCEPTION 'V60 changed current owners'; END IF;
END $$;
COMMENT ON COLUMN container_visit.previous_client_id IS 'Собственник до резервирования поставки; используется при отмене, NULL означает отсутствие прежнего собственника.';
COMMENT ON COLUMN container_visit.reserved_at IS 'Рабочее время резервирования поставки.';
COMMENT ON COLUMN container_visit.reserved_recorded_at IS 'Неизменяемый технический порядок визитов КТК (UTC).';
COMMENT ON COLUMN container_visit.shipping_recorded_at IS 'Технический порядок фактического вывоза (UTC), очищается при отмене.';
COMMENT ON COLUMN container_owner.last_stock_at IS 'Максимальное время складской операции, включая отмены; защита от календаря раньше выполненных действий.';
COMMENT ON COLUMN container_owner.last_recorded_at IS 'Последняя техническая отметка операции КТК (UTC); задаёт порядок независимо от журнала.';
COMMENT ON TABLE container_owner_history IS 'Журнал результатов операций, только добавление. Основной учёт и отмены не читают журнал.';
