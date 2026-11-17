-- Keep existing periods and legacy ownership changes untouched. New changes split storage.
-- No tables or columns are added: the boundary event determines its meaning.
ALTER TABLE container_storage_period
    DROP CONSTRAINT storage_shipping_source_check,
    DROP CONSTRAINT container_storage_period_check2,
    ADD CONSTRAINT storage_shipping_source_check CHECK (
        shipping_order_container_id IS NULL OR shipping_at IS NOT NULL),
    ADD CONSTRAINT storage_period_status_boundary_check CHECK (
        (status='OPEN' AND shipping_at IS NULL)
        OR (status='CLOSED' AND shipping_at IS NOT NULL)
        OR (status='CANCELLED' AND shipping_order_container_id IS NULL));

-- Checked at transaction end because a transfer closes one row, opens another,
-- and assigns the single OWNER_CHANGE event to the new row in the same transaction.
CREATE FUNCTION check_storage_period_boundaries(period_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    p container_storage_period%ROWTYPE;
    a container_owner_history%ROWTYPE;
    z container_owner_history%ROWTYPE;
    neighbour container_storage_period%ROWTYPE;
    effective_owner uuid;
BEGIN
    SELECT * INTO p FROM container_storage_period WHERE id=period_id;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT * INTO a FROM container_owner_history WHERE id=p.receiving_history_id;
    IF a.operation_type NOT IN ('ARRIVAL','OWNER_CHANGE') OR a.cancellation
       OR a.container_id IS DISTINCT FROM p.container_id
       OR a.terminal_area_id IS DISTINCT FROM p.terminal_area_id
       OR a.occurred_at IS DISTINCT FROM p.receiving_at
       OR a.storage_period_id IS DISTINCT FROM p.id
       OR a.new_client_id IS DISTINCT FROM p.receiving_owner_id THEN
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
           OR (neighbour.container_id,neighbour.terminal_area_id,neighbour.receiving_order_id,
               neighbour.receiving_order_container_id,neighbour.waybill_container_id,
               neighbour.receiving_client_id,neighbour.is_empty)
              IS DISTINCT FROM
              (p.container_id,p.terminal_area_id,p.receiving_order_id,p.receiving_order_container_id,
               p.waybill_container_id,p.receiving_client_id,p.is_empty)
           OR neighbour.shipping_at IS DISTINCT FROM p.receiving_at
           OR (neighbour.status='CANCELLED')<>(p.status='CANCELLED') THEN
            RAISE EXCEPTION 'Invalid storage ownership predecessor for %',p.id USING ERRCODE='23514';
        END IF;
    END IF;
    IF p.shipping_history_id IS NULL THEN RETURN; END IF;
    SELECT * INTO z FROM container_owner_history WHERE id=p.shipping_history_id;
    IF z.operation_type NOT IN ('DEPARTURE','OWNER_CHANGE') OR z.cancellation
       OR z.container_id IS DISTINCT FROM p.container_id
       OR z.terminal_area_id IS DISTINCT FROM p.terminal_area_id
       OR z.occurred_at IS DISTINCT FROM p.shipping_at THEN
        RAISE EXCEPTION 'Invalid storage end event for %',p.id USING ERRCODE='23514';
    END IF;
    IF z.operation_type='DEPARTURE' THEN
        IF p.status<>'CLOSED' OR z.order_type<>'SHIPPING_ORDER' OR z.storage_period_id IS DISTINCT FROM p.id
           OR NOT EXISTS (SELECT 1 FROM shipping_order_container s
               WHERE s.id=p.shipping_order_container_id AND s.shipping_order_id=z.order_id) THEN
            RAISE EXCEPTION 'Departure requires its exact shipping row for %',p.id USING ERRCODE='23514';
        END IF;
    ELSE
        SELECT * INTO neighbour FROM container_storage_period WHERE receiving_history_id=z.id;
        IF NOT FOUND OR neighbour.id=p.id OR p.shipping_order_container_id IS NOT NULL
           OR z.storage_period_id IS DISTINCT FROM neighbour.id
           OR z.new_client_id IS DISTINCT FROM neighbour.receiving_owner_id
           OR (neighbour.status='CANCELLED')<>(p.status='CANCELLED') THEN
            RAISE EXCEPTION 'Invalid storage ownership successor for %',p.id USING ERRCODE='23514';
        END IF;
        -- Old unsplit periods may contain ownership changes predating this feature.
        -- Preserve their owner snapshot; validate against their last recorded owner instead.
        SELECT h.new_client_id INTO effective_owner FROM container_owner_history h
        WHERE h.storage_period_id=p.id AND h.operation_type='OWNER_CHANGE'
          AND h.id<>p.receiving_history_id AND h.occurred_at<=z.occurred_at
          AND NOT EXISTS (SELECT 1 FROM container_storage_period x WHERE x.receiving_history_id=h.id)
        ORDER BY h.occurred_at DESC,h.created_at DESC,h.id DESC LIMIT 1;
        effective_owner:=coalesce(effective_owner,p.receiving_owner_id);
        IF z.old_client_id IS DISTINCT FROM effective_owner THEN
            RAISE EXCEPTION 'Storage owner does not match transfer for %',p.id USING ERRCODE='23514';
        END IF;
    END IF;
END $$;

CREATE FUNCTION validate_storage_period_boundaries() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE linked_id uuid;
BEGIN
    IF TG_TABLE_NAME='container_storage_period' THEN
        IF TG_OP<>'DELETE' THEN PERFORM check_storage_period_boundaries(NEW.id); END IF;
        -- A changed/removed boundary must not leave its neighbour disconnected.
        IF TG_OP<>'INSERT' THEN
            FOR linked_id IN SELECT id FROM container_storage_period
              WHERE receiving_history_id=OLD.shipping_history_id OR shipping_history_id=OLD.receiving_history_id
            LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
        END IF;
        IF TG_OP<>'DELETE' THEN
            FOR linked_id IN SELECT id FROM container_storage_period
              WHERE receiving_history_id=NEW.shipping_history_id OR shipping_history_id=NEW.receiving_history_id
            LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
        END IF;
    ELSE
        FOR linked_id IN SELECT id FROM container_storage_period
          WHERE receiving_history_id=NEW.id OR shipping_history_id=NEW.id
        LOOP PERFORM check_storage_period_boundaries(linked_id); END LOOP;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER storage_period_boundary_events
AFTER INSERT OR UPDATE OR DELETE ON container_storage_period
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_storage_period_boundaries();
CREATE CONSTRAINT TRIGGER storage_history_boundary_events
AFTER UPDATE ON container_owner_history
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_storage_period_boundaries();

COMMENT ON COLUMN container_storage_period.receiving_at IS 'Начало периода собственника: приём либо смена собственника; тип определяется receiving_history_id.';
COMMENT ON COLUMN container_storage_period.shipping_at IS 'Окончание периода: вывоз либо смена собственника; тип определяется shipping_history_id. День смены относится новому собственнику.';
COMMENT ON COLUMN container_storage_period.receiving_history_id IS 'Событие ARRIVAL или OWNER_CHANGE, открывшее период.';
COMMENT ON COLUMN container_storage_period.shipping_history_id IS 'Событие DEPARTURE или OWNER_CHANGE, закрывшее период.';
COMMENT ON COLUMN container_storage_period.receiving_owner_id IS 'Собственник на начало периода. Старые периоды не разделялись задним числом.';
COMMENT ON COLUMN container_storage_period.receiving_order_id IS 'Исходная физическая поставка; сохраняется при смене собственника.';
COMMENT ON COLUMN container_storage_period.receiving_order_container_id IS 'Точная строка исходной автопоставки; сохраняется во всей цепочке собственников.';
COMMENT ON COLUMN container_storage_period.waybill_container_id IS 'Точная строка исходной ЖД-поставки; сохраняется во всей цепочке собственников.';
COMMENT ON COLUMN container_storage_period.status IS 'OPEN — открыт; CLOSED — завершён вывозом или сменой собственника; CANCELLED — физический приём аннулирован.';
COMMENT ON COLUMN container_owner_history.storage_period_id IS 'Период события. При новом OWNER_CHANGE — открытый им период; предыдущий связан через shipping_history_id.';
