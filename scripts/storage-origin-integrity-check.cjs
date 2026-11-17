// Deliberately invalid chains are rolled back on the isolated V47 database only.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const db='billing_storage_origin_test',docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
assert.equal(sql('select current_database()'),db);
assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'47');
assert.equal(sql("select count(*) from information_schema.columns where table_name='container_storage_period' and table_schema='public'"),'7');
assert.equal(sql("select count(*) from container_storage_period p full join container_storage_period_origin o using(id) where p.id is null or o.id is null or o.receiving_order_id is distinct from storage_receiving_order(p.id)"),'0');
const f=JSON.parse(fs.readFileSync('backups/storage-owner-fixtures.json'));assert.equal(f.db,db);
function rejected(q,pattern=/Invalid storage|violates.*constraint|duplicate key/){let failed=false;try{sql("BEGIN; SET LOCAL statement_timeout='5s'; "+q+"; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;");}catch(e){failed=true;assert.match(String(e.stderr),pattern);}assert.ok(failed,'Invalid chain accepted');}
rejected("delete from container_storage_period where id='"+f.previousPeriodId+"'");
rejected("delete from receiving_order where id='"+f.receivingId+"'",/Invalid storage origin: receiving order is referenced/);
rejected("update receiving_order set id=gen_random_uuid() where id='"+f.receivingId+"'",/Invalid storage origin: receiving order is referenced/);
// A cycle has locally plausible OWNER_CHANGE boundaries but no ARRIVAL root.
rejected(`
 CREATE TEMP TABLE cycle_ids AS SELECT gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() h1,gen_random_uuid() h2;
 INSERT INTO container_owner_history
 SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object(
  'id',m.h1,'storage_period_id',null,'occurred_at',timestamptz '2026-11-22 12:00+03'))).*
 FROM cycle_ids m CROSS JOIN LATERAL (select * from container_owner_history where operation_type='OWNER_CHANGE' limit 1)h;
 INSERT INTO container_owner_history
 SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object(
  'id',m.h2,'storage_period_id',null,'old_client_id',h.new_client_id,'new_client_id',h.old_client_id))).*
 FROM cycle_ids m JOIN container_owner_history h ON h.id=m.h1;
 INSERT INTO container_storage_period(id,container_id,receiving_history_id,shipping_history_id,status)
 SELECT m.p1,h.container_id,m.h1,m.h2,'CLOSED' FROM cycle_ids m JOIN container_owner_history h ON h.id=m.h1
 UNION ALL SELECT m.p2,h.container_id,m.h2,m.h1,'CLOSED' FROM cycle_ids m JOIN container_owner_history h ON h.id=m.h2;
 UPDATE container_owner_history h SET storage_period_id=case when h.id=m.h1 then m.p1 else m.p2 end
 FROM cycle_ids m WHERE h.id in (m.h1,m.h2)
`,/Invalid storage origin chain.*cycle/);
// A detached owner-change start cannot form a new physical visit.
rejected(`
 CREATE TEMP TABLE detached AS SELECT gen_random_uuid() p,gen_random_uuid() event_id;
 INSERT INTO container_owner_history
 SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object('id',m.event_id,'storage_period_id',null))).*
 FROM detached m CROSS JOIN LATERAL (select * from container_owner_history where operation_type='OWNER_CHANGE' limit 1)h;
 INSERT INTO container_storage_period(id,container_id,receiving_history_id,status)
 SELECT m.p,h.container_id,m.event_id,'CANCELLED' FROM detached m JOIN container_owner_history h ON h.id=m.event_id;
 UPDATE container_owner_history h SET storage_period_id=m.p FROM detached m WHERE h.id=m.event_id
`,/Invalid storage origin chain.*missing predecessor/);
console.log('PASS: seven columns; all origins agree, cycles/disconnected chains and deletion/key changes of original receipts rejected');
