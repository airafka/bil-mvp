-- Verify every saved date, including cancelled and future assignments, before removing it.
LOCK TABLE container_period, container_owner_history IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE mismatch uuid;
BEGIN
    SELECT p.id INTO mismatch
    FROM container_period p LEFT JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
    WHERE p.effective_at IS DISTINCT FROM h.occurred_at LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Period % has a different start time from its history event', mismatch;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION set_container_period_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT CASE WHEN order_type='SERVICE_ORDER' THEN order_id END INTO STRICT NEW.service_order_id
    FROM container_owner_history WHERE id=NEW.start_container_owner_history_id;
    RETURN NEW;
END $$;

-- Keep the active projection in physical column order for apply_container_history's container_period row.
ALTER VIEW active_container_period RENAME TO active_container_period_v80;
CREATE VIEW active_container_period AS
SELECT p.id,p.container_visit_id,p.client_id,p.start_container_owner_history_id,p.service_order_id
FROM container_period p LEFT JOIN service_order s ON s.id=p.service_order_id
WHERE s.status IS DISTINCT FROM 'CANCELLED';

CREATE OR REPLACE VIEW ownership_assignment_timeline AS
SELECT p.id,v.container_id,p.container_visit_id,p.client_id,h.occurred_at AS action_at,
       h.created_at AS recorded_at,h.id AS ordering_id,(h.occurred_at AT TIME ZONE 'Europe/Moscow')::date AS effective_date
FROM active_container_period p JOIN container_visit v ON v.id=p.container_visit_id
JOIN container_owner_history h ON h.id=p.start_container_owner_history_id WHERE v.cancellation_container_owner_history_id IS NULL;

-- Rebind existing storage and history views to the replacement projection.
CREATE OR REPLACE VIEW container_storage_period AS
WITH boundaries AS (
    SELECT p.id,v.container_id,h.id AS start_history_id,
           coalesce(lead(h.id) OVER (PARTITION BY v.id ORDER BY h.occurred_at,h.created_at,h.id),
                    v.shipping_container_owner_history_id) AS end_history_id,
           v.cancellation_container_owner_history_id AS cancellation_id,h.created_at AT TIME ZONE 'UTC' AS recorded_at
    FROM active_container_period p JOIN container_visit v ON v.id=p.container_visit_id
    JOIN container_owner_history h ON h.id=p.start_container_owner_history_id
)
SELECT b.id,b.container_id,b.start_history_id,b.end_history_id,
       (CASE WHEN cancellation_id IS NOT NULL THEN 'CANCELLED' WHEN end_history_id IS NULL THEN 'OPEN' ELSE 'CLOSED' END)::varchar(20) AS status,
       b.recorded_at AS created_at,
       greatest(b.recorded_at,e.created_at AT TIME ZONE 'UTC',c.created_at AT TIME ZONE 'UTC') AS updated_at
FROM boundaries b LEFT JOIN container_owner_history e ON e.id=b.end_history_id
LEFT JOIN container_owner_history c ON c.id=b.cancellation_id;

CREATE OR REPLACE VIEW container_owner_history_view AS
SELECT h.id, h.new_client_id, h.old_client_id, h.container_id, h.order_id, h.order_type,
       h.new_status, h.old_status, h.created_at, h.created_by, h.updated_at, h.updated_by, h.occurred_at,
       CASE
           WHEN kind.operation_type IN ('ARRIVAL','OWNER_CHANGE') THEN
               (SELECT p.id FROM container_period p WHERE p.start_container_owner_history_id=h.id)
           WHEN kind.operation_type IN ('RESERVE_RECEIVING','CANCEL_RECEIVING_RESERVATION') THEN NULL
           ELSE (
               -- Reconstruct the visit known when this event was recorded. Cancelling a later
               -- receipt can restore an earlier visit, including for cancellation of its departure.
               SELECT p.id FROM active_container_period p
               JOIN container_owner_history start_event ON start_event.id=p.start_container_owner_history_id
               WHERE p.container_visit_id=(
                   SELECT v.id FROM container_visit v
                   JOIN container_owner_history arrival ON arrival.id=v.receiving_container_owner_history_id
                   LEFT JOIN container_owner_history cancelled ON cancelled.id=v.cancellation_container_owner_history_id
                   WHERE v.container_id=h.container_id AND arrival.created_at<=h.created_at
                     AND (cancelled.id IS NULL OR cancelled.created_at>=h.created_at)
                   ORDER BY arrival.created_at DESC LIMIT 1
               )
               -- A later backdated transfer changes the storage timeline, but was unknown to this event.
               AND start_event.created_at<=h.created_at AND start_event.occurred_at<=h.occurred_at
               ORDER BY start_event.occurred_at DESC, start_event.created_at DESC, start_event.id DESC LIMIT 1
           )
       END AS container_period_id,
       kind.operation_type,
       kind.operation_type IN ('CANCEL_ARRIVAL','CANCEL_DEPARTURE','CANCEL_RECEIVING_RESERVATION','CANCEL_SHIPPING_RESERVATION') AS cancellation
FROM container_owner_history h
CROSS JOIN LATERAL (SELECT history_operation_type(h.order_type,h.old_status,h.new_status) AS operation_type) kind;

DROP VIEW active_container_period_v80;
ALTER TABLE container_period DROP COLUMN effective_at;
