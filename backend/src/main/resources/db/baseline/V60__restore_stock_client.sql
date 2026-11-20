-- Preserve the V59 date resolver separately from the operational register.
DO $$ BEGIN
 EXECUTE 'CREATE VIEW container_owner_effective AS ' || pg_get_viewdef('container_owner_current'::regclass,true);
END $$;
ALTER TABLE container_owner ADD COLUMN client_id uuid REFERENCES client(id);
UPDATE container_owner o SET client_id=e.client_id FROM container_owner_effective e WHERE e.id=o.id;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- Never guess an owner during migration; ambiguous legacy data must be reconciled.
ALTER TABLE container_owner ALTER COLUMN client_id SET NOT NULL;
CREATE INDEX container_owner_client_id_idx ON container_owner(client_id);
COMMENT ON COLUMN container_owner.client_id IS 'Текущий собственник КТК. Синхронизируется по рабочей дате при операциях, смене календаря и обращении к API; будущая передача не применяется раньше даты.';
COMMENT ON VIEW container_owner_effective IS 'Определение собственника по датированным назначениям и событиям резерва/отмены; источник обновления текущего регистра.';

CREATE OR REPLACE VIEW container_owner_current AS
 SELECT o.id,o.container_id,o.status,o.shipping_order_id,o.created_at,o.created_by,o.updated_at,o.updated_by,o.container_visit_id,o.version,
 coalesce(o.receiving_order_id,v.receiving_order_id) AS receiving_order_id,o.client_id
 FROM container_owner o LEFT JOIN container_visit v ON v.id=o.container_visit_id;

-- Call under the same calendar/container lock order as stock operations.
-- No history or ownership rows are created by a clock refresh.
CREATE FUNCTION refresh_container_owner_clients(container_ids uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
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
 UPDATE container_owner o SET client_id=e.client_id,version=o.version+1,
  updated_at=billing_now() AT TIME ZONE 'UTC',updated_by='local'
 FROM container_owner_effective e WHERE e.id=o.id AND o.container_id=ANY(changed_ids)
  AND e.client_id IS NOT NULL AND o.client_id IS DISTINCT FROM e.client_id;
 GET DIAGNOSTICS changed=ROW_COUNT;
 UPDATE shipping_order_container sc SET owner_container_id=o.client_id
 FROM shipping_order s,container_owner o
 WHERE s.id=sc.shipping_order_id AND s.order_status='DRAFT' AND o.container_id=sc.container_id
  AND o.container_id=ANY(changed_ids) AND sc.owner_container_id IS DISTINCT FROM o.client_id;
 RETURN changed;
END $$;
COMMENT ON FUNCTION refresh_container_owner_clients(uuid[]) IS 'Актуализация регистра без шедулера и новых событий истории. Календарь до первого события не удаляет последнего известного собственника.';
