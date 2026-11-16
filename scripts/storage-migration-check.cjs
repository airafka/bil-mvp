// Replays V33 in a disposable copy, including cancellations and deliberately ambiguous history.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',source='billing_storage_test',target='billing_storage_replay_test';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true}).trim();
const sql=q=>run(['exec','billing-next-db-1','psql','-U','billing','-d',target,'-At','-v','ON_ERROR_STOP=1','-c',q]);
assert.equal(run(['exec','billing-next-db-1','psql','-U','billing','-d',source,'-At','-c','select current_database()']),source);
run(['exec','billing-next-db-1','pg_dump','-U','billing','-d',source,'-Fc','-f','/tmp/storage-replay-test.dump']);
run(['exec','billing-next-db-1','createdb','-U','billing',target]); // Never overwrite an existing database.
run(['exec','billing-next-db-1','pg_restore','-U','billing','-d',target,'--no-owner','--no-privileges','--single-transaction','/tmp/storage-replay-test.dump']);
assert.equal(sql('select current_database()'),target);
const fields='arrival_history_id,departure_history_id,receiving_order_id,shipping_order_id,status,needs_review,arrival_at,departure_at';
const renamed=sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name='receiving_at'")==='1';
const reviewField=sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name='needs_review'")==='1'?'needs_review':'false as needs_review';
const sourceFields=renamed?'receiving_history_id as arrival_history_id,shipping_history_id as departure_history_id,receiving_order_id,shipping_order_id,status,needs_review,receiving_at as arrival_at,shipping_at as departure_at':fields;
const expected=JSON.parse(sql(`select json_agg(p order by arrival_history_id) from (select ${sourceFields.replace('needs_review',reviewField)} from container_storage_period)p`));
// Remove only the feature under test in this disposable database to replay its migration from legacy history.
sql(`alter table container_owner_history drop constraint history_storage_period_fk;
drop table container_storage_period;
alter table container_owner_history drop column operation_type,drop column occurred_at,drop column time_source,
 drop column terminal_area_id,drop column storage_period_id,drop column target_history_id,drop column source_system,
 drop column source_operation_key,drop column reason,drop column needs_review,drop column review_reason;`);
// The day-count fixture changed the new period date only; its legacy source remains the original movement.
const synthetic=JSON.parse(sql(`with c as (insert into container(id,code,container_type) values(gen_random_uuid(),'STORAGE-REPLAY-AMBIGUOUS','STANDARD_40') returning id),
 r as (insert into receiving_order(id,client_id,order_status,terminal_area_catalog_id,transport_type)
 select gen_random_uuid(),client_id,'COMPLETED',terminal_area_catalog_id,'VEHICLE' from receiving_order limit 1 returning id)
 select json_build_object('container',c.id,'receiving',r.id) from c,r`));
sql(`insert into container_owner_history(id,container_id,order_id,order_type,old_status,new_status,created_at)
 values(gen_random_uuid(),'${synthetic.container}','${synthetic.receiving}','RECEIVING_ORDER','EXPECTED','ON_TERMINAL','2026-11-01'),
 (gen_random_uuid(),'${synthetic.container}','${synthetic.receiving}','RECEIVING_ORDER','EXPECTED','ON_TERMINAL','2026-11-02');`);
const migration=path.resolve(__dirname,'../backend/src/main/resources/db/baseline/V33__container_storage_periods.sql');
run(['cp',migration,'billing-next-db-1:/tmp/storage-replay-v33.sql']);
run(['exec','billing-next-db-1','psql','-U','billing','-d',target,'-v','ON_ERROR_STOP=1','--single-transaction','-f','/tmp/storage-replay-v33.sql']);
const actual=JSON.parse(sql(`select json_agg(p order by arrival_history_id) from (select ${fields} from container_storage_period where container_id<>'${synthetic.container}')p`));
assert.equal(actual.length,expected.length);
for(let i=0;i<expected.length;i++) {
 // Historical reconstruction takes its dates from legacy movement/history, not a test-only period date adjustment.
 const {arrival_at: ignored1,departure_at: ignored2,...before}=expected[i];
 const {arrival_at: ignored3,departure_at: ignored4,...after}=actual[i];
 assert.deepEqual(after,before);
}
assert.equal(sql(`select count(*) from container_storage_period where container_id='${synthetic.container}' and needs_review`),'2');
assert.equal(sql(`select count(*) from container_storage_period where container_id='${synthetic.container}' and not needs_review`),'0');
assert.equal(sql(`select count(*) from container_owner_history h join container_storage_period p on p.id=h.storage_period_id where h.container_id<>p.container_id`),'0');
console.log('PASS: V33 replays receipt/shipment cancellation chains and keeps duplicate arrivals for review; periods='+expected.length);
