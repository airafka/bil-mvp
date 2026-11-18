-- Synthetic read workload, only on the explicitly named test database. All FK/check triggers stay enabled.
DO $$ BEGIN
 IF current_database()<>'billing_storage_chain_perf_test' THEN RAISE EXCEPTION 'Test database required'; END IF;
 IF (SELECT max(version::int) FROM flyway_schema_history WHERE success)<>51 THEN RAISE EXCEPTION 'V51 required'; END IF;
 IF EXISTS(SELECT 1 FROM container WHERE code LIKE 'VIEU%') THEN RAISE EXCEPTION 'Benchmark already generated'; END IF;
END $$;
BEGIN;
SELECT setval('transport_order_number_seq',greatest((SELECT last_value FROM transport_order_number_seq),(SELECT max(number) FROM receiving_order),(SELECT max(number) FROM shipping_order)),true);
CREATE TEMP TABLE fixture AS
 SELECT p.*,source_r.terminal_area_catalog_id area,source_h.new_client_id owner
 FROM container_storage_period_view p JOIN receiving_order source_r ON source_r.id=p.receiving_order_id
 JOIN container_owner_history_view source_h ON source_h.id=p.start_history_id
 JOIN container_owner_history_view source_z ON source_z.id=p.end_history_id
 WHERE p.receiving_order_container_id IS NOT NULL AND p.shipping_order_container_id IS NOT NULL
 AND source_h.operation_type='ARRIVAL' AND source_z.operation_type='DEPARTURE' AND p.status='CLOSED' LIMIT 1;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM fixture) THEN RAISE EXCEPTION 'Closed auto fixture required'; END IF; END $$;
CREATE TEMP TABLE bench_map AS SELECT n,gen_random_uuid() c,gen_random_uuid() r,gen_random_uuid() s,
 gen_random_uuid() rc,gen_random_uuid() sc,gen_random_uuid() h,gen_random_uuid() z,gen_random_uuid() p,
 n%3<>0 closed FROM generate_series(1,10000)n;
INSERT INTO container SELECT (jsonb_populate_record(NULL::container,to_jsonb(source_c)||jsonb_build_object(
 'id',m.c,'code','VIEU'||lpad(m.n::text,7,'0')))).*
 FROM bench_map m CROSS JOIN fixture f JOIN container source_c ON source_c.id=f.container_id;
INSERT INTO receiving_order SELECT (jsonb_populate_record(NULL::receiving_order,to_jsonb(source_r)||jsonb_build_object(
 'id',m.r,'number',nextval('transport_order_number_seq'),'route_id',NULL,'comprehensive_service_order_id',NULL,
 'source_shipping_order_id',NULL))).*
 FROM bench_map m CROSS JOIN fixture f JOIN receiving_order source_r ON source_r.id=f.receiving_order_id;
INSERT INTO receiving_order_container SELECT (jsonb_populate_record(NULL::receiving_order_container,to_jsonb(source_rc)||jsonb_build_object(
 'id',m.rc,'receiving_order_id',m.r,'container_id',m.c,'source_shipping_order_id',NULL,'empty',false))).*
 FROM bench_map m CROSS JOIN fixture f JOIN receiving_order_container source_rc ON source_rc.id=f.receiving_order_container_id;
INSERT INTO receiving_order_container_item(id,receiving_order_container_id,etsng_code_id,wight_net)
 SELECT gen_random_uuid(),m.rc,ec.id,100 FROM bench_map m CROSS JOIN (SELECT id FROM etsng_code ORDER BY id LIMIT 2)ec;
INSERT INTO shipping_order SELECT (jsonb_populate_record(NULL::shipping_order,to_jsonb(source_s)||jsonb_build_object(
 'id',m.s,'number',nextval('transport_order_number_seq'),'route_id',NULL,'comprehensive_service_order_id',NULL,
 'source_receiving_order_id',NULL))).*
 FROM bench_map m CROSS JOIN fixture f JOIN shipping_order_container source_sc ON source_sc.id=f.shipping_order_container_id
 JOIN shipping_order source_s ON source_s.id=source_sc.shipping_order_id WHERE m.closed;
INSERT INTO shipping_order_container SELECT (jsonb_populate_record(NULL::shipping_order_container,to_jsonb(source_sc)||jsonb_build_object(
 'id',m.sc,'shipping_order_id',m.s,'container_id',m.c))).*
 FROM bench_map m CROSS JOIN fixture f JOIN shipping_order_container source_sc ON source_sc.id=f.shipping_order_container_id WHERE m.closed;
INSERT INTO container_owner_history SELECT (jsonb_populate_record(NULL::container_owner_history,to_jsonb(source_h)||jsonb_build_object(
 'id',m.h,'container_id',m.c,'order_id',m.r,'storage_period_id',NULL,
 'occurred_at',timestamptz '2025-01-01 09:00:00+03'+(m.n%365)*interval '1 day'))).*
 FROM bench_map m CROSS JOIN fixture f JOIN container_owner_history_view source_h ON source_h.id=f.start_history_id;
INSERT INTO container_owner_history SELECT (jsonb_populate_record(NULL::container_owner_history,to_jsonb(source_z)||jsonb_build_object(
 'id',m.z,'container_id',m.c,'order_id',m.s,'storage_period_id',NULL,
 'occurred_at',timestamptz '2025-01-08 09:00:00+03'+(m.n%365)*interval '1 day'))).*
 FROM bench_map m CROSS JOIN fixture f JOIN container_owner_history_view source_z ON source_z.id=f.end_history_id WHERE m.closed;
INSERT INTO container_storage_period(id,container_id,start_history_id,end_history_id,status,arrival_history_id)
 SELECT p,c,h,CASE WHEN closed THEN z END,CASE WHEN closed THEN 'CLOSED' ELSE 'OPEN' END,h FROM bench_map;
UPDATE container_owner_history h SET storage_period_id=m.p FROM bench_map m WHERE h.id=m.h OR (m.closed AND h.id=m.z);
COMMIT;
ANALYZE;


-- Extend the existing isolated V51 benchmark with 100 visits having ten ownership changes each.
DO $$ BEGIN
 IF current_database()<>'billing_storage_chain_perf_test' THEN RAISE EXCEPTION 'Test database required'; END IF;
 IF (SELECT max(version::int) FROM flyway_schema_history WHERE success)<>51 THEN RAISE EXCEPTION 'V51 required'; END IF;
 IF EXISTS(SELECT 1 FROM service_order WHERE comment='V52 benchmark chain') THEN RAISE EXCEPTION 'Already generated'; END IF;
END $$;
BEGIN;
SELECT setval('transport_order_number_seq',greatest((SELECT last_value FROM transport_order_number_seq),(SELECT max(number) FROM receiving_order),(SELECT max(number) FROM shipping_order)),true);
SELECT setval('order_code_seq',greatest((SELECT last_value FROM order_code_seq),(SELECT max(number) FROM service_order)),true);
DO $$
DECLARE root record; current_period uuid; next_period uuid; event_id uuid; order_id uuid; prior_owner uuid; next_owner uuid;
 template_order jsonb; template_history jsonb; alternative uuid; n int;
BEGIN
 SELECT to_jsonb(s) INTO STRICT template_order FROM service_order s WHERE service='CHANGE_OWNER' AND status='DONE' LIMIT 1;
 SELECT to_jsonb(h) INTO STRICT template_history FROM container_owner_history_view h WHERE operation_type='OWNER_CHANGE' LIMIT 1;
 FOR root IN SELECT p.*,h.new_client_id owner,h.occurred_at arrived,r.terminal_area_catalog_id area
  FROM container_storage_period_view p JOIN container c ON c.id=p.container_id
  JOIN container_owner_history_view h ON h.id=p.start_history_id
  JOIN receiving_order r ON r.id=p.receiving_order_id
  WHERE c.code LIKE 'VIEU%' AND p.status='OPEN' AND h.operation_type='ARRIVAL' ORDER BY p.id LIMIT 100
 LOOP
  SELECT id INTO STRICT alternative FROM client WHERE id<>root.owner ORDER BY id LIMIT 1;
  current_period:=root.id; prior_owner:=root.owner;
  FOR n IN 1..10 LOOP
   next_period:=gen_random_uuid();event_id:=gen_random_uuid();order_id:=gen_random_uuid();
   next_owner:=CASE WHEN n%2=0 THEN root.owner ELSE alternative END;
   INSERT INTO service_order SELECT (jsonb_populate_record(NULL::service_order,template_order||jsonb_build_object(
    'id',order_id,'number',nextval('order_code_seq'),'client_id',next_owner,'comment','V52 benchmark chain'))).*;
   INSERT INTO container_owner_history SELECT (jsonb_populate_record(NULL::container_owner_history,template_history||jsonb_build_object(
    'id',event_id,'container_id',root.container_id,'order_id',order_id,'order_type','SERVICE_ORDER',
    'old_client_id',prior_owner,'new_client_id',next_owner,'old_status','ON_TERMINAL','new_status','ON_TERMINAL',
    'occurred_at',root.arrived+n*interval '1 hour',
    'storage_period_id',NULL))).*;
   UPDATE container_storage_period SET status='CLOSED',end_history_id=event_id WHERE id=current_period;
   INSERT INTO container_storage_period(id,container_id,arrival_history_id,start_history_id,status)
    VALUES(next_period,root.container_id,root.arrival_history_id,event_id,'OPEN');
   UPDATE container_owner_history SET storage_period_id=next_period WHERE id=event_id;
   current_period:=next_period;prior_owner:=next_owner;
  END LOOP;
 END LOOP;
END $$;
COMMIT;
ANALYZE;
