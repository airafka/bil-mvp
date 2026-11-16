// Isolated migration comparison. Capture a restored V38/V39 before starting the V40 backend.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const db='billing_storage_shipping_test',docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
assert.equal(sql('select current_database()'),db);
const snapshot=path.resolve(__dirname,'../backups/storage-shipping-before.json');
function rows(){const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'"));return sql(tables.map(t=>{
 let e='to_jsonb(t)';if(t==='container_storage_period')e+="-'shipping_order_id'";
 // V39 may be pending on the source copy. Only its six explicitly removed fields are excluded.
 if(t==='container_owner_history')e+="-'target_history_id'-'source_system'-'source_operation_key'-'reason'-'needs_review'-'review_reason'";
 return `select json_build_object('table','${t}','count',count(*),'hash',md5(coalesce(string_agg((${e})::text,chr(10) order by (${e})::text),''))) from public."${t}" t`;
}).join(' union all '));}
if(process.argv[2]==='capture'){
 const version=Number(sql('select max(version::int) from flyway_schema_history where success'));assert.ok([38,39].includes(version));assert.ok(!fs.existsSync(snapshot));
 assert.equal(sql('select count(*) from container_storage_period p left join shipping_order_container sc on sc.id=p.shipping_order_container_id where p.shipping_order_id is distinct from sc.shipping_order_id'),'0');
 fs.writeFileSync(snapshot,rows());console.log('Captured source V'+version+' business data');
}else{
 assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'40');assert.equal(rows(),fs.readFileSync(snapshot,'utf8'));
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name='shipping_order_id'"),'0');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name='receiving_order_id' and is_nullable='NO'"),'1');
 assert.equal(sql("select count(*) from container_storage_period p join shipping_order_container sc on sc.id=p.shipping_order_container_id where p.container_id<>sc.container_id"),'0');
 assert.match(sql("select pg_get_constraintdef(oid) from pg_constraint where conrelid='container_storage_period'::regclass and conname='storage_shipping_container_fk'"),/FOREIGN KEY \(shipping_order_container_id, container_id\) REFERENCES shipping_order_container\(id, container_id\)/);
 sql("do $$ declare p uuid; begin select id into p from container_storage_period where status='CLOSED' limit 1; if p is not null then begin update container_storage_period set shipping_history_id=null where id=p; raise exception 'Missing shipping history accepted'; exception when check_violation then null; end; end if; end $$");
 console.log('PASS: shipping order column removed, receiving order and all other values preserved; source FK and history/date checks retained');
}
