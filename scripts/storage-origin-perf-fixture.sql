-- Extend the existing isolated V46 benchmark with 100 visits having ten ownership changes each.
DO $$ BEGIN
 IF current_database()<>'billing_storage_view_test' THEN RAISE EXCEPTION 'Test database required'; END IF;
 IF (SELECT max(version::int) FROM flyway_schema_history WHERE success)<>46 THEN RAISE EXCEPTION 'V46 required'; END IF;
 IF EXISTS(SELECT 1 FROM service_order WHERE comment='V47 benchmark chain') THEN RAISE EXCEPTION 'Already generated'; END IF;
END $$;
BEGIN;
DO $$
DECLARE root record; current_period uuid; next_period uuid; event_id uuid; order_id uuid; prior_owner uuid; next_owner uuid;
 template_order jsonb; template_history jsonb; alternative uuid; n int;
BEGIN
 SELECT to_jsonb(s) INTO STRICT template_order FROM service_order s WHERE service='CHANGE_OWNER' AND status='DONE' LIMIT 1;
 SELECT to_jsonb(h) INTO STRICT template_history FROM container_owner_history h WHERE operation_type='OWNER_CHANGE' LIMIT 1;
 FOR root IN SELECT p.*,h.new_client_id owner,h.occurred_at arrived,r.terminal_area_catalog_id area
  FROM container_storage_period p JOIN container c ON c.id=p.container_id
  JOIN container_owner_history h ON h.id=p.receiving_history_id
  JOIN receiving_order r ON r.id=p.receiving_order_id
  WHERE c.code LIKE 'VIEU%' AND p.status='OPEN' AND h.operation_type='ARRIVAL' ORDER BY p.id LIMIT 100
 LOOP
  SELECT id INTO STRICT alternative FROM client WHERE id<>root.owner ORDER BY id LIMIT 1;
  current_period:=root.id; prior_owner:=root.owner;
  FOR n IN 1..10 LOOP
   next_period:=gen_random_uuid();event_id:=gen_random_uuid();order_id:=gen_random_uuid();
   next_owner:=CASE WHEN n%2=0 THEN root.owner ELSE alternative END;
   INSERT INTO service_order SELECT (jsonb_populate_record(NULL::service_order,template_order||jsonb_build_object(
    'id',order_id,'number',nextval('order_code_seq'),'client_id',next_owner,'comment','V47 benchmark chain'))).*;
   INSERT INTO container_owner_history SELECT (jsonb_populate_record(NULL::container_owner_history,template_history||jsonb_build_object(
    'id',event_id,'container_id',root.container_id,'order_id',order_id,'order_type','SERVICE_ORDER',
    'old_client_id',prior_owner,'new_client_id',next_owner,'old_status','ON_TERMINAL','new_status','ON_TERMINAL',
    'cancellation',false,'operation_type','OWNER_CHANGE','occurred_at',root.arrived+n*interval '1 hour',
    'terminal_area_id',root.area,'storage_period_id',NULL))).*;
   UPDATE container_storage_period SET status='CLOSED',shipping_history_id=event_id WHERE id=current_period;
   INSERT INTO container_storage_period(id,container_id,receiving_order_id,receiving_history_id,status)
    VALUES(next_period,root.container_id,root.receiving_order_id,event_id,'OPEN');
   UPDATE container_owner_history SET storage_period_id=next_period WHERE id=event_id;
   current_period:=next_period;prior_owner:=next_owner;
  END LOOP;
 END LOOP;
END $$;
COMMIT;
ANALYZE;
