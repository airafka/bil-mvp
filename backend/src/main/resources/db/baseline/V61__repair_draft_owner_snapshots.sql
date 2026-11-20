-- Repair draft snapshots left by a concurrent owner change before V61.
-- Confirmed/completed shipments keep their historical owner. No business event,
-- visit or dated ownership assignment is created or changed by this repair.
DO $$ BEGIN
 PERFORM billing_today();
 PERFORM c.id FROM container c
 WHERE EXISTS (
  SELECT 1 FROM container_owner o
  JOIN shipping_order_container sc ON sc.container_id=o.container_id
  JOIN shipping_order s ON s.id=sc.shipping_order_id
  WHERE o.container_id=c.id AND s.order_status='DRAFT'
   AND sc.owner_container_id IS DISTINCT FROM o.client_id
 ) ORDER BY c.id FOR UPDATE;
 UPDATE shipping_order_container sc SET owner_container_id=o.client_id
 FROM shipping_order s,container_owner o
 WHERE s.id=sc.shipping_order_id AND s.order_status='DRAFT'
  AND o.container_id=sc.container_id
  AND sc.owner_container_id IS DISTINCT FROM o.client_id;
END $$;
