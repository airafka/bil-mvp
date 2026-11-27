-- Preserve the table, primary key, client index and attached triggers, including the optional DB viewer.
-- Flyway runs this migration as one transaction.
LOCK TABLE container_owner IN ACCESS EXCLUSIVE MODE;

-- PostgreSQL 16 materializes stored generated columns when adding them. DROP EXPRESSION
-- keeps their values as ordinary writable columns without making any stock movements.
ALTER TABLE container_owner
    ADD COLUMN v87_container_id uuid GENERATED ALWAYS AS (container_id) STORED NOT NULL,
    ADD COLUMN v87_receiving_order_id uuid GENERATED ALWAYS AS (receiving_order_id) STORED,
    ADD COLUMN v87_shipping_order_id uuid GENERATED ALWAYS AS (shipping_order_id) STORED,
    ADD COLUMN v87_status varchar(30) GENERATED ALWAYS AS (status) STORED NOT NULL,
    ADD COLUMN v87_created_at timestamp GENERATED ALWAYS AS (created_at) STORED NOT NULL,
    ADD COLUMN v87_created_by varchar(50) GENERATED ALWAYS AS (created_by) STORED NOT NULL,
    ADD COLUMN v87_updated_at timestamp GENERATED ALWAYS AS (updated_at) STORED,
    ADD COLUMN v87_updated_by varchar(50) GENERATED ALWAYS AS (updated_by) STORED;

ALTER TABLE container_owner
    ALTER COLUMN v87_container_id DROP EXPRESSION,
    ALTER COLUMN v87_receiving_order_id DROP EXPRESSION,
    ALTER COLUMN v87_shipping_order_id DROP EXPRESSION,
    ALTER COLUMN v87_status DROP EXPRESSION,
    ALTER COLUMN v87_created_at DROP EXPRESSION,
    ALTER COLUMN v87_created_by DROP EXPRESSION,
    ALTER COLUMN v87_updated_at DROP EXPRESSION,
    ALTER COLUMN v87_updated_by DROP EXPRESSION;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM container_owner
        WHERE (container_id, receiving_order_id, shipping_order_id, status, created_at, created_by, updated_at, updated_by)
              IS DISTINCT FROM
              (v87_container_id, v87_receiving_order_id, v87_shipping_order_id, v87_status, v87_created_at, v87_created_by, v87_updated_at, v87_updated_by)
    ) THEN
        RAISE EXCEPTION 'Container owner values differ after column copy';
    END IF;
END $$;

DROP VIEW container_owner_effective;
DROP VIEW container_owner_current;

-- Local constraints on the replaced columns are recreated below. RESTRICT protects external dependants.
ALTER TABLE container_owner
    DROP COLUMN container_id,
    DROP COLUMN receiving_order_id,
    DROP COLUMN shipping_order_id,
    DROP COLUMN status,
    DROP COLUMN created_at,
    DROP COLUMN created_by,
    DROP COLUMN updated_at,
    DROP COLUMN updated_by,
    DROP COLUMN version;

ALTER TABLE container_owner RENAME COLUMN v87_container_id TO container_id;
ALTER TABLE container_owner RENAME COLUMN v87_receiving_order_id TO receiving_order_id;
ALTER TABLE container_owner RENAME COLUMN v87_shipping_order_id TO shipping_order_id;
ALTER TABLE container_owner RENAME COLUMN v87_status TO status;
ALTER TABLE container_owner RENAME COLUMN v87_created_at TO created_at;
ALTER TABLE container_owner RENAME COLUMN v87_created_by TO created_by;
ALTER TABLE container_owner RENAME COLUMN v87_updated_at TO updated_at;
ALTER TABLE container_owner RENAME COLUMN v87_updated_by TO updated_by;

ALTER TABLE container_owner
    ADD CONSTRAINT container_owner_container_id_key UNIQUE (container_id),
    ADD CONSTRAINT container_owner_container_id_fkey FOREIGN KEY (container_id) REFERENCES container(id),
    ADD CONSTRAINT container_owner_receiving_order_id_fkey FOREIGN KEY (receiving_order_id) REFERENCES receiving_order(id),
    ADD CONSTRAINT container_owner_shipping_order_id_fkey FOREIGN KEY (shipping_order_id) REFERENCES shipping_order(id),
    ADD CONSTRAINT container_owner_status_check CHECK (status IN ('EXPECTED','ON_TERMINAL','RESERVED_OUT','DEPARTED')),
    ALTER COLUMN created_at SET DEFAULT (billing_now() AT TIME ZONE 'UTC'),
    ALTER COLUMN created_by SET DEFAULT 'local';

COMMENT ON COLUMN container_owner.receiving_order_id IS 'Текущая поставка КТК. Сохраняется после приёмки, при передаче и вывозе. При отмене поставки восстанавливается предыдущая действующая поставка, если она была.';
COMMENT ON COLUMN container_owner.shipping_order_id IS 'Текущий вывоз при резерве или выбытии, предыдущий действующий вывоз после новой поставки или отмены вывоза.';

CREATE OR REPLACE VIEW container_owner_current AS
SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
       v.id AS container_visit_id,o.receiving_order_id,o.client_id
FROM container_owner o LEFT JOIN container_visit_facts v ON v.container_id=o.container_id
    AND v.receiving_order_id=o.receiving_order_id AND NOT v.is_cancelled AND o.status<>'EXPECTED';

CREATE OR REPLACE VIEW container_owner_effective AS
SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,
       o.container_visit_id,o.receiving_order_id,owner.client_id
FROM container_owner_current o LEFT JOIN LATERAL (
    SELECT h.new_client_id AS client_id FROM container_owner_history_view h
    LEFT JOIN container_period p ON p.start_container_owner_history_id=h.id
    LEFT JOIN container_visit v ON v.id=p.container_visit_id
    WHERE h.container_id=o.container_id AND (h.occurred_at AT TIME ZONE 'Europe/Moscow')::date<=billing_today()
      AND (p.service_order_id IS NULL OR EXISTS (SELECT 1 FROM service_order s WHERE s.id=p.service_order_id AND s.status='DONE'))
      AND ((p.id IS NOT NULL AND v.cancellation_container_owner_history_id IS NULL)
        OR (h.operation_type='RESERVE_RECEIVING' AND o.status='EXPECTED' AND h.order_id=o.receiving_order_id)
        OR h.operation_type IN ('CANCEL_RECEIVING_RESERVATION','CANCEL_ARRIVAL'))
    ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1
) owner ON true;

COMMENT ON VIEW container_owner_effective IS 'Определение собственника по датированным назначениям и событиям резерва/отмены; источник обновления текущего регистра.';

CREATE OR REPLACE FUNCTION public.refresh_owner_snapshot(container_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE changed_ids uuid[]; changed integer;
BEGIN
 PERFORM billing_today();
 SELECT array_agg(id ORDER BY id) INTO changed_ids FROM (
  SELECT c.id FROM container c JOIN container_owner o ON o.container_id=c.id
  JOIN container_owner_effective e ON e.id=o.id
  WHERE (container_ids IS NULL OR c.id=ANY(container_ids))
   AND e.client_id IS NOT NULL AND o.client_id IS DISTINCT FROM e.client_id
  ORDER BY c.id FOR UPDATE OF c
 ) locked;
 IF changed_ids IS NULL THEN RETURN 0; END IF;
 -- Re-resolve after acquiring locks: another operation may have completed while waiting.
 UPDATE container_owner o SET client_id=e.client_id,
  updated_at=billing_now() AT TIME ZONE 'UTC',updated_by='local'
 FROM container_owner_effective e WHERE e.id=o.id AND o.container_id=ANY(changed_ids)
  AND e.client_id IS NOT NULL AND o.client_id IS DISTINCT FROM e.client_id;
 GET DIAGNOSTICS changed=ROW_COUNT;
 UPDATE shipping_order_container sc SET container_owner_id=o.client_id
 FROM shipping_order s,container_owner o
 WHERE s.id=sc.shipping_order_id AND s.order_status='DRAFT' AND o.container_id=sc.container_id
  AND o.container_id=ANY(changed_ids) AND sc.container_owner_id IS DISTINCT FROM o.client_id;
 RETURN changed;
END $function$;

ANALYZE container_owner;
