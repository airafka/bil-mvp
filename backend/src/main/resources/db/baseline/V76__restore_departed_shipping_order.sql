-- A cancelled repeat receiving order on an older schema could clear the last shipment.
-- The restored receiving reference identifies the exact physical visit of the departed unit.
UPDATE container_owner AS owner
SET shipping_order_id = visit.shipping_order_id
FROM container_visit_facts AS visit
WHERE owner.status = 'DEPARTED'
  AND owner.shipping_order_id IS NULL
  AND visit.container_id = owner.container_id
  AND visit.receiving_order_id = owner.receiving_order_id
  AND NOT visit.is_cancelled
  AND visit.shipping_order_id IS NOT NULL;
