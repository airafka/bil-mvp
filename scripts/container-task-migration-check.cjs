// Read-only comparison of a restored V36 fixture with V37. Run capture before backend migration.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const db='billing_container_tasks_test',docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
assert.equal(sql('select current_database()'),db);
const snapshot=path.resolve(__dirname,'../backups/container-task-before.json');
function rows(){const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'"));return sql(tables.map(t=>{
 let e='to_jsonb(t)';if(['receiving_order_container','shipping_order_container','waybill_container'].includes(t))e+="-'status'";
 if(t==='container_storage_period')e+="-'receiving_order_container_id'-'waybill_container_id'-'shipping_order_container_id'";
 return `select json_build_object('table','${t}','count',count(*),'hash',md5(coalesce(string_agg((${e})::text,chr(10) order by (${e})::text),''))) from public."${t}" t`;
}).join(' union all '));}
if(process.argv[2]==='capture'){
 assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'36');assert.ok(!fs.existsSync(snapshot));fs.writeFileSync(snapshot,rows());console.log('Captured V36 business data');
}else{
 assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'37');assert.equal(rows(),fs.readFileSync(snapshot,'utf8'),'Unexpected existing business data change');
 for(const [table,order,key,extra]of [['receiving_order_container','receiving_order','receiving_order_id',"and o.transport_type='VEHICLE'"],['shipping_order_container','shipping_order','shipping_order_id','']])
  assert.equal(sql(`select count(*) from ${table} c join ${order} o on o.id=c.${key} where c.status is distinct from (case when true ${extra} then case o.order_status when 'CONFIRMED' then 'UPLOADED' when 'COMPLETED' then 'FINISHED' end end)`),'0');
 assert.equal(sql("select count(*) from waybill_container c join waybill_railway_carriage wr on wr.id=c.waybill_railway_carriage_id join waybill w on w.id=wr.waybill_id left join receiving_order o on o.id=w.receiving_order_id where c.status is distinct from (case when o.transport_type='RAILWAY' then case o.order_status when 'CONFIRMED' then 'UPLOADED' when 'COMPLETED' then 'FINISHED' end end)"),'0');
 assert.equal(sql("select count(*) from container_storage_period where not needs_review and (num_nonnulls(receiving_order_container_id,waybill_container_id)<>1 or (shipping_at is not null and shipping_order_container_id is null))"),'0');
 console.log('PASS: original business data preserved, statuses backfilled, exact task references present');
 console.log('Periods requiring review: '+sql('select count(*) from container_storage_period where needs_review'));
}
