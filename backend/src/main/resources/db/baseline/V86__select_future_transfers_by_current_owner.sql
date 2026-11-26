-- The owner selected on a future order can differ from the predecessor of its dated event.
DROP FUNCTION ownership_transfer_candidates(date, uuid, uuid);

CREATE FUNCTION ownership_transfer_candidates(transfer_date date, target_client uuid, own_order uuid)
RETURNS TABLE(owner_id uuid, container_id uuid, container_visit_id uuid, previous_client_id uuid,
              transfer_at timestamptz, selection_client_id uuid)
LANGUAGE sql STABLE AS $$
    SELECT o.id, o.container_id, v.id, p.client_id,
           greatest(transfer_date::timestamp AT TIME ZONE 'Europe/Moscow',
                    CASE WHEN p.effective_date = transfer_date THEN p.action_at + interval '1 microsecond' END,
                    CASE WHEN transfer_date = billing_today() THEN billing_now() END),
           source.client_id
    FROM container_owner o
    JOIN container_visit_facts v ON v.receiving_order_id = o.receiving_order_id AND v.container_id = o.container_id
    LEFT JOIN service_order own ON own.id = own_order
    JOIN LATERAL (
        SELECT op.client_id, op.effective_date, op.action_at
        FROM ownership_assignment_timeline op
        WHERE op.container_visit_id = v.id AND op.effective_date <= transfer_date
        ORDER BY op.effective_date DESC, op.action_at DESC, op.recorded_at DESC, op.ordering_id DESC
        LIMIT 1
    ) p ON true
    CROSS JOIN LATERAL (
        SELECT CASE WHEN transfer_date > billing_today() THEN o.client_id ELSE p.client_id END AS client_id
    ) source
    WHERE EXISTS (
        SELECT 1 FROM visit_receiving_tasks t WHERE t.receiving_order_id = v.receiving_order_id
            AND t.container_id = v.container_id AND t.status = 'FINISHED'
    )
      AND o.status = 'ON_TERMINAL' AND NOT v.is_cancelled AND v.shipping_date IS NULL
      AND v.receiving_date <= transfer_date AND v.receiving_date <= billing_today()
      AND p.client_id <> target_client AND source.client_id <> target_client
      AND (own.old_client_owner_id IS NULL OR own.old_client_owner_id = source.client_id)
      AND NOT EXISTS (
          SELECT 1 FROM service_order_container sc JOIN service_order s ON s.id = sc.service_order_id
          WHERE sc.container_id = o.container_id AND sc.result_status = 'DRAFT'
            AND s.status = 'DRAFT' AND s.id IS DISTINCT FROM own_order
      );
$$;
