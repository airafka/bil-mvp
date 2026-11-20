-- Stage 1: report reads visits and dated ownership, without reading the event journal.
-- Existing write/cancellation algorithms and compatibility views are intentionally retained.
ALTER TABLE container_visit ADD COLUMN receiving_at timestamptz, ADD COLUMN shipping_at timestamptz;
ALTER TABLE container_ownership_period ADD COLUMN effective_at timestamptz,
 ADD COLUMN recorded_at timestamp, ADD COLUMN service_order_id uuid REFERENCES service_order(id);

UPDATE container_visit v SET receiving_at=h.occurred_at FROM container_owner_history h
 WHERE h.id=v.receiving_container_owner_history_id;
UPDATE container_visit v SET shipping_at=h.occurred_at FROM container_owner_history h
 WHERE h.id=v.shipping_container_owner_history_id;
UPDATE container_ownership_period p SET effective_at=h.occurred_at,recorded_at=h.created_at,
 service_order_id=CASE WHEN h.order_type='SERVICE_ORDER' THEN h.order_id END
 FROM container_owner_history h WHERE h.id=p.start_container_owner_history_id;
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE container_visit ADD CONSTRAINT visit_receiving_time CHECK
 ((receiving_at IS NULL)=(receiving_date IS NULL) AND (receiving_at AT TIME ZONE 'Europe/Moscow')::date=receiving_date),
 ADD CONSTRAINT visit_shipping_time CHECK
 ((shipping_at IS NULL)=(shipping_date IS NULL) AND (shipping_at AT TIME ZONE 'Europe/Moscow')::date=shipping_date);
ALTER TABLE container_ownership_period ALTER COLUMN effective_at SET NOT NULL,ALTER COLUMN recorded_at SET NOT NULL,
 ADD CONSTRAINT ownership_effective_time CHECK((effective_at AT TIME ZONE 'Europe/Moscow')::date=effective_date);
CREATE UNIQUE INDEX ownership_recorded_order ON container_ownership_period(container_id,recorded_at);
CREATE INDEX ownership_report_visit ON container_ownership_period(container_visit_id,effective_date,effective_at,recorded_at)
 WHERE NOT is_withdrawn;

-- Transitional write adapters: capture precise facts once in the same operation transaction.
-- Report queries never invoke these triggers or consult the journal.
CREATE FUNCTION capture_visit_report_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.receiving_container_owner_history_id IS DISTINCT FROM OLD.receiving_container_owner_history_id THEN
  NEW.receiving_at:=NULL;
  IF NEW.receiving_container_owner_history_id IS NOT NULL THEN
   SELECT occurred_at INTO STRICT NEW.receiving_at FROM container_owner_history WHERE id=NEW.receiving_container_owner_history_id;
  END IF;
 ELSIF NEW.receiving_at IS DISTINCT FROM OLD.receiving_at THEN
  RAISE EXCEPTION 'Receiving report time must match the operation' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' OR NEW.shipping_container_owner_history_id IS DISTINCT FROM OLD.shipping_container_owner_history_id THEN
  NEW.shipping_at:=NULL;
  IF NEW.shipping_container_owner_history_id IS NOT NULL THEN
   SELECT occurred_at INTO STRICT NEW.shipping_at FROM container_owner_history WHERE id=NEW.shipping_container_owner_history_id;
  END IF;
 ELSIF NEW.shipping_at IS DISTINCT FROM OLD.shipping_at THEN
  RAISE EXCEPTION 'Shipping report time must match the operation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER visit_report_facts BEFORE INSERT OR UPDATE ON container_visit
 FOR EACH ROW EXECUTE FUNCTION capture_visit_report_facts();

CREATE FUNCTION capture_ownership_report_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h container_owner_history%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO STRICT h FROM container_owner_history WHERE id=NEW.start_container_owner_history_id;
  NEW.effective_at:=h.occurred_at;NEW.recorded_at:=h.created_at;
  NEW.service_order_id:=CASE WHEN h.order_type='SERVICE_ORDER' THEN h.order_id END;
 ELSIF (NEW.effective_at,NEW.recorded_at,NEW.service_order_id) IS DISTINCT FROM (OLD.effective_at,OLD.recorded_at,OLD.service_order_id) THEN
  RAISE EXCEPTION 'Ownership report origin is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ownership_report_facts BEFORE INSERT OR UPDATE ON container_ownership_period
 FOR EACH ROW EXECUTE FUNCTION capture_ownership_report_facts();

CREATE FUNCTION container_storage_report_at(report_date date)
RETURNS TABLE(id uuid,container_id uuid,container_visit_id uuid,client_id uuid,
 start_at timestamptz,end_at timestamptz,recorded_at timestamp,
 start_order_id uuid,start_order_type varchar,end_order_id uuid,end_order_type varchar,status varchar,
 receiving_order_id uuid,receiving_order_container_id uuid,waybill_container_id uuid,shipping_order_container_id uuid)
LANGUAGE sql STABLE AS $$
 WITH eligible AS (
  SELECT p.*,v.is_cancelled AS visit_cancelled,v.receiving_order_id,v.receiving_order_container_id,v.waybill_container_id,
   v.shipping_at,v.shipping_order_container_id,
   lead(p.effective_at) OVER chain AS next_at,lead(p.service_order_id) OVER chain AS next_service_order_id
  FROM container_ownership_period p JOIN container_visit v ON v.id=p.container_visit_id
  WHERE NOT p.is_withdrawn AND v.receiving_at IS NOT NULL AND
   (p.record_type='STORAGE' OR (p.record_type='EXPECTED' AND p.service_order_id IS NOT NULL AND p.effective_at>=v.receiving_at))
  WINDOW chain AS (PARTITION BY p.container_visit_id ORDER BY p.effective_date,p.effective_at,p.recorded_at)
 ), boundaries AS (
  SELECT p.*,coalesce(p.next_at,p.shipping_at) AS boundary_at,
   CASE WHEN p.next_at IS NOT NULL THEN p.next_service_order_id ELSE s.shipping_order_id END AS boundary_order_id,
   CASE WHEN p.next_at IS NOT NULL THEN 'SERVICE_ORDER' WHEN p.shipping_at IS NOT NULL THEN 'SHIPPING_ORDER' END AS boundary_order_type
  FROM eligible p LEFT JOIN shipping_order_container s ON s.id=p.shipping_order_container_id
 ) SELECT p.id,p.container_id,p.container_visit_id,p.client_id,p.effective_at,
  CASE WHEN (p.boundary_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN p.boundary_at END,p.recorded_at,
  coalesce(p.service_order_id,p.receiving_order_id),
  (CASE WHEN p.service_order_id IS NOT NULL THEN 'SERVICE_ORDER' ELSE 'RECEIVING_ORDER' END)::varchar,
  CASE WHEN (p.boundary_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN p.boundary_order_id END,
  (CASE WHEN (p.boundary_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN p.boundary_order_type END)::varchar,
  (CASE WHEN (p.boundary_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN 'CLOSED' ELSE 'OPEN' END)::varchar,
  p.receiving_order_id,p.receiving_order_container_id,p.waybill_container_id,
  CASE WHEN p.next_at IS NULL AND (p.shipping_at AT TIME ZONE 'Europe/Moscow')::date<=report_date THEN p.shipping_order_container_id END
 FROM boundaries p WHERE NOT p.is_cancelled AND NOT p.visit_cancelled AND p.effective_date<=report_date
$$;

-- Verify the migrated facts at every existing boundary date, including the day before it.
DO $$ DECLARE d date; BEGIN
 FOR d IN SELECT DISTINCT day FROM (
  SELECT effective_date AS day FROM container_ownership_period UNION SELECT effective_date-1 FROM container_ownership_period
  UNION SELECT shipping_date FROM container_visit UNION SELECT shipping_date-1 FROM container_visit UNION SELECT billing_today()
 ) dates WHERE day IS NOT NULL LOOP
  IF EXISTS (
   WITH old_rows AS (
    SELECT p.id,p.container_id,op.container_visit_id,op.client_id,h.occurred_at AS start_at,e.occurred_at AS end_at,
     h.created_at AS recorded_at,h.order_id AS start_order_id,h.order_type::varchar AS start_order_type,
     e.order_id AS end_order_id,e.order_type::varchar AS end_order_type,p.status
    FROM container_storage_period_at(d) p JOIN container_ownership_period op ON op.id=p.id
    JOIN container_owner_history h ON h.id=p.start_history_id LEFT JOIN container_owner_history e ON e.id=p.end_history_id
    WHERE p.status IN ('OPEN','CLOSED')
   ), new_rows AS (
    SELECT id,container_id,container_visit_id,client_id,start_at,end_at,recorded_at,start_order_id,start_order_type,end_order_id,end_order_type,status
    FROM container_storage_report_at(d)
   ) (SELECT * FROM old_rows EXCEPT ALL SELECT * FROM new_rows) UNION ALL (SELECT * FROM new_rows EXCEPT ALL SELECT * FROM old_rows)
  ) THEN RAISE EXCEPTION 'Storage report migration differs on %',d; END IF;
 END LOOP;
END $$;

COMMENT ON FUNCTION container_storage_report_at(date) IS 'Отчёт хранения на дату из визитов и назначений собственника; чтение не зависит от истории событий.';
COMMENT ON COLUMN container_visit.receiving_at IS 'Точное время фактической поставки для отчёта; дата по Europe/Moscow равна receiving_date.';
COMMENT ON COLUMN container_visit.shipping_at IS 'Точное время фактического вывоза для отчёта; при отмене вывоза очищается.';
COMMENT ON COLUMN container_ownership_period.effective_at IS 'Точный момент начала назначения; дата по Europe/Moscow равна effective_date.';
COMMENT ON COLUMN container_ownership_period.recorded_at IS 'Неизменяемый порядок регистрации назначения (UTC); разрешает совпадение дат и времени действия.';
COMMENT ON COLUMN container_ownership_period.service_order_id IS 'Заявка передачи собственника; NULL для назначения, созданного поставкой или её отменой.';
