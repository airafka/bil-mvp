-- Synthetic read workload, only on the explicitly named test database. All FK/check triggers stay enabled.
DO $$ BEGIN
 IF current_database()<>'billing_storage_view_test' THEN RAISE EXCEPTION 'Test database required'; END IF;
 IF EXISTS(SELECT 1 FROM container WHERE code LIKE 'VIEU%') THEN RAISE EXCEPTION 'Benchmark already generated'; END IF;
END $$;
BEGIN;
CREATE TEMP TABLE fixture AS
 SELECT p.*,source_r.terminal_area_catalog_id area,source_h.new_client_id owner
 FROM container_storage_period p JOIN receiving_order source_r ON source_r.id=p.receiving_order_id
 JOIN container_owner_history source_h ON source_h.id=p.receiving_history_id
 JOIN container_owner_history source_z ON source_z.id=p.shipping_history_id
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
 'id',m.r,'number',nextval('order_code_seq'),'route_id',NULL,'comprehensive_service_order_id',NULL,
 'source_shipping_order_id',NULL))).*
 FROM bench_map m CROSS JOIN fixture f JOIN receiving_order source_r ON source_r.id=f.receiving_order_id;
INSERT INTO receiving_order_container SELECT (jsonb_populate_record(NULL::receiving_order_container,to_jsonb(source_rc)||jsonb_build_object(
 'id',m.rc,'receiving_order_id',m.r,'container_id',m.c,'source_shipping_order_id',NULL,'empty',false))).*
 FROM bench_map m CROSS JOIN fixture f JOIN receiving_order_container source_rc ON source_rc.id=f.receiving_order_container_id;
INSERT INTO receiving_order_container_item(id,receiving_order_container_id,etsng_code_id,wight_net)
 SELECT gen_random_uuid(),m.rc,ec.id,100 FROM bench_map m CROSS JOIN (SELECT id FROM etsng_code ORDER BY id LIMIT 2)ec;
INSERT INTO shipping_order SELECT (jsonb_populate_record(NULL::shipping_order,to_jsonb(source_s)||jsonb_build_object(
 'id',m.s,'number',nextval('order_code_seq'),'route_id',NULL,'comprehensive_service_order_id',NULL,
 'source_receiving_order_id',NULL))).*
 FROM bench_map m CROSS JOIN fixture f JOIN shipping_order_container source_sc ON source_sc.id=f.shipping_order_container_id
 JOIN shipping_order source_s ON source_s.id=source_sc.shipping_order_id WHERE m.closed;
INSERT INTO shipping_order_container SELECT (jsonb_populate_record(NULL::shipping_order_container,to_jsonb(source_sc)||jsonb_build_object(
 'id',m.sc,'shipping_order_id',m.s,'container_id',m.c))).*
 FROM bench_map m CROSS JOIN fixture f JOIN shipping_order_container source_sc ON source_sc.id=f.shipping_order_container_id WHERE m.closed;
INSERT INTO container_owner_history SELECT (jsonb_populate_record(NULL::container_owner_history,to_jsonb(source_h)||jsonb_build_object(
 'id',m.h,'container_id',m.c,'order_id',m.r,'storage_period_id',NULL,
 'occurred_at',timestamptz '2025-01-01 09:00:00+03'+(m.n%365)*interval '1 day'))).*
 FROM bench_map m CROSS JOIN fixture f JOIN container_owner_history source_h ON source_h.id=f.receiving_history_id;
INSERT INTO container_owner_history SELECT (jsonb_populate_record(NULL::container_owner_history,to_jsonb(source_z)||jsonb_build_object(
 'id',m.z,'container_id',m.c,'order_id',m.s,'storage_period_id',NULL,
 'occurred_at',timestamptz '2025-01-08 09:00:00+03'+(m.n%365)*interval '1 day'))).*
 FROM bench_map m CROSS JOIN fixture f JOIN container_owner_history source_z ON source_z.id=f.shipping_history_id WHERE m.closed;
INSERT INTO container_storage_period(id,container_id,receiving_order_id,receiving_history_id,shipping_history_id,status,receiving_order_container_id,shipping_order_container_id)
 SELECT p,c,r,h,CASE WHEN closed THEN z END,CASE WHEN closed THEN 'CLOSED' ELSE 'OPEN' END,rc,CASE WHEN closed THEN sc END FROM bench_map;
UPDATE container_owner_history h SET storage_period_id=m.p FROM bench_map m WHERE h.id=m.h OR (m.closed AND h.id=m.z);
COMMIT;
ANALYZE;

