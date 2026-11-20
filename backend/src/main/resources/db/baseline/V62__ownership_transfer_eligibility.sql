-- Pin the transferor to the document. Older drafts had no declared transferor.
ALTER TABLE service_order
    ADD COLUMN source_client_id uuid REFERENCES client(id),
    ADD CONSTRAINT service_order_distinct_clients CHECK (source_client_id <> client_id);

-- For confirmed orders use only the snapshot taken at acceptance. Some legacy
-- documents had several transferors or incomplete snapshots and stay nullable.
WITH single_source AS (
    SELECT service_order_id, (array_agg(DISTINCT expected_client_id))[1] AS client
    FROM service_order_container
    GROUP BY service_order_id
    HAVING count(*) = count(expected_client_id) AND count(DISTINCT expected_client_id) = 1
)
UPDATE service_order s SET source_client_id = src.client
FROM single_source src
WHERE src.service_order_id = s.id AND s.status <> 'DRAFT' AND src.client <> s.client_id;

CREATE OR REPLACE VIEW service_order_current AS
    SELECT s.id, s.number, s.client_id, s.service, s.comment,
           (CASE WHEN s.status = 'CONFIRMED' THEN
             CASE WHEN x.pending > 0 THEN 'SCHEDULED' WHEN x.applied = 0 THEN 'CANCELLED'
                  WHEN x.applied = x.total THEN 'DONE' ELSE 'PARTIAL' END
            ELSE s.status END)::varchar(20) AS status,
           s.completion_at, s.created_at, s.created_by, s.updated_at, s.updated_by,
           s.effective_date, s.source_client_id
    FROM service_order s
    LEFT JOIN LATERAL (
        SELECT count(*) AS total, count(*) FILTER (WHERE result_status = 'PLANNED') AS pending,
               count(*) FILTER (WHERE result_status = 'APPLIED') AS applied
        FROM service_order_container_current sc WHERE sc.service_order_id = s.id
    ) x ON true;

CREATE OR REPLACE FUNCTION ownership_transfer_candidates(transfer_date date, target_client uuid, own_order uuid)
RETURNS TABLE(owner_id uuid, container_id uuid, container_visit_id uuid, previous_client_id uuid, transfer_at timestamptz)
LANGUAGE sql STABLE AS $$
    SELECT o.id, o.container_id, v.id, p.client_id,
           greatest(transfer_date::timestamp AT TIME ZONE 'Europe/Moscow',
                    CASE WHEN p.effective_date = transfer_date THEN p.occurred_at + interval '1 microsecond' END,
                    CASE WHEN transfer_date = billing_today() THEN billing_now() END)
    FROM container_owner o
    JOIN container_visit v ON v.id = o.container_visit_id
    JOIN receiving_order r ON r.id = v.receiving_order_id AND r.order_status = 'COMPLETED'
    LEFT JOIN service_order own ON own.id = own_order
    JOIN LATERAL (
        SELECT op.client_id, op.effective_date, h.occurred_at
        FROM container_ownership_period op
        JOIN container_owner_history h ON h.id = op.start_container_owner_history_id
        WHERE op.container_visit_id = v.id AND NOT op.is_cancelled AND NOT op.is_withdrawn
          AND op.effective_date <= transfer_date
        ORDER BY op.effective_date DESC, h.occurred_at DESC, h.created_at DESC, h.id DESC
        LIMIT 1
    ) p ON true
    WHERE o.status = 'ON_TERMINAL' AND NOT v.is_cancelled AND v.shipping_date IS NULL
      AND v.receiving_date <= transfer_date AND v.receiving_date <= billing_today()
      AND p.client_id <> target_client
      AND (own.source_client_id IS NULL OR own.source_client_id = p.client_id)
      AND NOT EXISTS (
          SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id = sc.service_order_id
          WHERE sc.container_id = o.container_id AND s.status = 'DRAFT' AND s.id IS DISTINCT FROM own_order
      );
$$;
