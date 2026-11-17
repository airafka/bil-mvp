// Restore a V42 copy to billing_stock_history_migration_test before running; no backend required.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_stock_history_migration_test';
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024}).trim();
assert.equal(sql('select current_database()'),db);assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'42');
const migration=fs.readFileSync(path.join(__dirname,'../backend/src/main/resources/db/baseline/V43__restore_stock_from_history.sql'),'utf8');
const reservation="select s.order_id,s.order_type,s.container_id from container_stock_reservation s join receiving_order r on r.id=s.order_id and s.order_type='RECEIVING_ORDER' where r.order_status<>'CANCELLED' limit 1";
function rejected(change,pattern){
 let failed=false;try{sql('begin; '+change+'; '+migration+'; rollback;')}catch(e){assert.match(String(e.stderr),pattern);failed=true;}
 assert.ok(failed);assert.equal(sql("select to_regclass('container_stock_reservation') is not null and to_regclass('history_container_recorded_uq') is null"),'t');
}
rejected("update container_owner_history set created_at='2000-01-01' where container_id=(select container_id from container_owner_history group by container_id having count(*)>1 limit 1)",/Duplicate history recording times/);
rejected(`update container_stock_reservation set previous_client_id=case when previous_client_id is null then (select id from client limit 1) else null end where (order_id,order_type,container_id)=(${reservation})`,/Reservation owner differs/);
rejected(`update container_owner_history h set operation_type='UNKNOWN' where (order_id,order_type,container_id)=(${reservation}) and operation_type='RESERVE_RECEIVING'`,/Missing or ambiguous reservation history/);
sql('begin; '+migration+'; rollback;');
assert.equal(sql("select to_regclass('container_stock_reservation') is not null and to_regclass('history_container_recorded_uq') is null"),'t');
console.log('PASS: ambiguous chronology, owner mismatch and missing history block V43 atomically; valid migration succeeds and rolls back without changing the V42 fixture');
