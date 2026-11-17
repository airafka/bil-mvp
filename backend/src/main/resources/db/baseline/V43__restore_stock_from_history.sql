-- Restore prior non-cancelled documents from history, as in dev_back.
-- created_at is the recording order; occurred_at keeps the MVP business clock.
CREATE FUNCTION previous_stock_order(ktk uuid, cancelled_order uuid, kind varchar) RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE cutoff timestamp; first_event timestamp; matches integer; previous_order uuid;
BEGIN
    IF kind NOT IN ('RECEIVING_ORDER','SHIPPING_ORDER') THEN
        RAISE EXCEPTION 'Unsupported stock order type' USING ERRCODE='23514';
    END IF;
    SELECT count(*),min(created_at) INTO matches,cutoff FROM container_owner_history
      WHERE container_id=ktk AND order_id=cancelled_order AND order_type=kind AND NOT cancellation
        AND operation_type=CASE kind WHEN 'RECEIVING_ORDER' THEN 'RESERVE_RECEIVING' ELSE 'RESERVE_SHIPPING' END
        AND new_status=CASE kind WHEN 'RECEIVING_ORDER' THEN 'EXPECTED' ELSE 'RESERVED_OUT' END;
    SELECT min(created_at) INTO first_event FROM container_owner_history
      WHERE container_id=ktk AND order_id=cancelled_order AND order_type=kind;
    IF matches<>1 OR cutoff IS DISTINCT FROM first_event THEN
        RAISE EXCEPTION 'Missing or ambiguous reservation history for container %, order %',ktk,cancelled_order
          USING ERRCODE='23514';
    END IF;
    SELECT h.order_id INTO previous_order FROM container_owner_history h
      JOIN (
        SELECT id,order_status FROM receiving_order WHERE kind='RECEIVING_ORDER'
        UNION ALL SELECT id,order_status FROM shipping_order WHERE kind='SHIPPING_ORDER'
      ) o ON o.id=h.order_id
      WHERE h.container_id=ktk AND h.order_type=kind AND h.order_id<>cancelled_order
        AND o.order_status<>'CANCELLED' AND h.created_at<cutoff
      ORDER BY h.created_at DESC LIMIT 1;
    RETURN previous_order;
END $$;

-- Refuse ambiguous legacy chronology rather than choosing by a random UUID.
DO $$
DECLARE r record; old_owner uuid; previous_order uuid; snapshot_order uuid; visited uuid[];
BEGIN
    IF EXISTS (SELECT 1 FROM container_owner_history GROUP BY container_id,created_at HAVING count(*)>1) THEN
        RAISE EXCEPTION 'Duplicate history recording times require reconciliation before V43';
    END IF;
    FOR r IN
      SELECT s.* FROM container_stock_reservation s
      JOIN (SELECT id,order_status,'RECEIVING_ORDER' kind FROM receiving_order
            UNION ALL SELECT id,order_status,'SHIPPING_ORDER' FROM shipping_order) o
        ON o.id=s.order_id AND o.kind=s.order_type
      WHERE o.order_status<>'CANCELLED'
    LOOP
        previous_order:=previous_stock_order(r.container_id,r.order_id,r.order_type);
        SELECT old_client_id INTO old_owner FROM container_owner_history
          WHERE container_id=r.container_id AND order_id=r.order_id AND order_type=r.order_type
            AND NOT cancellation AND operation_type=CASE r.order_type
              WHEN 'RECEIVING_ORDER' THEN 'RESERVE_RECEIVING' ELSE 'RESERVE_SHIPPING' END;
        IF old_owner IS DISTINCT FROM r.previous_client_id THEN
            RAISE EXCEPTION 'Reservation owner differs from history for container %, order %',r.container_id,r.order_id;
        END IF;
        snapshot_order:=CASE r.order_type WHEN 'RECEIVING_ORDER' THEN r.previous_receiving_id ELSE r.previous_shipping_id END;
        visited:=ARRAY[r.order_id];
        -- A snapshot may refer to a document cancelled later. Follow those old snapshots
        -- only during migration to prove the surviving history gives the same active link.
        WHILE snapshot_order IS NOT NULL AND EXISTS (
          SELECT 1 FROM receiving_order WHERE r.order_type='RECEIVING_ORDER' AND id=snapshot_order AND order_status='CANCELLED'
          UNION ALL SELECT 1 FROM shipping_order WHERE r.order_type='SHIPPING_ORDER' AND id=snapshot_order AND order_status='CANCELLED'
        ) LOOP
            IF snapshot_order=ANY(visited) THEN
                RAISE EXCEPTION 'Cyclic reservation snapshots for container %',r.container_id;
            END IF;
            visited:=array_append(visited,snapshot_order);
            SELECT CASE r.order_type WHEN 'RECEIVING_ORDER' THEN previous_receiving_id ELSE previous_shipping_id END
              INTO snapshot_order FROM container_stock_reservation
              WHERE container_id=r.container_id AND order_id=snapshot_order AND order_type=r.order_type;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Incomplete legacy reservation chain for container %',r.container_id;
            END IF;
        END LOOP;
        IF previous_order IS DISTINCT FROM snapshot_order THEN
            RAISE EXCEPTION 'Legacy history order differs from reservation snapshot for container %, order %',r.container_id,r.order_id;
        END IF;
    END LOOP;
END $$;

CREATE UNIQUE INDEX history_container_recorded_uq ON container_owner_history(container_id,created_at);
ALTER TABLE container_owner_history ALTER COLUMN created_at SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC');
CREATE FUNCTION assign_stock_history_recorded_at() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous_time timestamp;
BEGIN
    PERFORM 1 FROM container WHERE id=NEW.container_id FOR UPDATE;
    SELECT max(created_at) INTO previous_time FROM container_owner_history WHERE container_id=NEW.container_id;
    NEW.occurred_at:=coalesce(NEW.occurred_at,billing_now());
    NEW.created_at:=greatest(clock_timestamp() AT TIME ZONE 'UTC',previous_time+interval '1 microsecond');
    RETURN NEW;
END $$;
CREATE TRIGGER stock_history_recorded_at BEFORE INSERT ON container_owner_history
FOR EACH ROW EXECUTE FUNCTION assign_stock_history_recorded_at();

DROP TABLE container_stock_reservation;
COMMENT ON COLUMN container_owner_history.created_at IS 'Порядок записи истории (UTC), строго возрастает для КТК независимо от календаря MVP; не раньше системного времени и следующей микросекунды после прежней записи. Старые значения сохранены.';
COMMENT ON COLUMN container_owner_history.occurred_at IS 'Дата и время бизнес-события по календарю MVP; используется для хранения, движения и отображения истории.';
