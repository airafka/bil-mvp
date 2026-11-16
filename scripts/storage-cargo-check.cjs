// V40 -> V41 and live catalogue reads, strictly on an isolated database/backend.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const db='billing_storage_cargo_test',docker=process.env.DOCKER_EXE||'docker',base='http://127.0.0.1:8193/api';
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
const json=q=>JSON.parse(sql(q));assert.equal(sql('select current_database()'),db);
const snapshot=path.resolve(__dirname,'../backups/storage-cargo-before.json');
function state(){const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");return sql(tables.map(t=>{const e='to_jsonb(t)'+(t==='container_storage_period'?"-'cargo_name'":'');return `select json_build_object('table','${t}','count',count(*),'hash',md5(coalesce(string_agg((${e})::text,chr(10) order by (${e})::text),''))) from "${t}" t`;}).join(' union all '));}
async function api(p){const r=await fetch(base+p);assert.equal(r.status,200,p);return r.json();}
const period=async id=>{const r=await api('/container-storage-periods?status=ALL&periodId='+id);assert.equal(r.totalElements,1);return r.items[0];};
(async()=>{
 if(process.argv[2]==='capture'){assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'40');assert.ok(!fs.existsSync(snapshot));fs.writeFileSync(snapshot,state());console.log('Captured V40 business rows');return;}
 assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'41');
 if(process.argv[2]!=='api'){
  assert.equal(state(),fs.readFileSync(snapshot,'utf8'));
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name='cargo_name'"),'0');
  console.log('PASS: V41 removes only cargo_name, all other business values and source links preserved');return;
 }
 const inspect=JSON.parse(execFileSync(docker,['inspect','billing-next-storage-cargo-test'],{encoding:'utf8',windowsHide:true}))[0];
 assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8193'));
 const auto=json("select row_to_json(p) from container_storage_period p where receiving_order_container_id is not null order by created_at desc limit 1");
 const rail=json("select row_to_json(p) from container_storage_period p where waybill_container_id is not null order by created_at desc limit 1");
 assert.ok(auto&&rail,'Lifecycle fixtures must provide both receiving types');
 const codes=json("with inserted as (insert into etsng_code(id,code) values(gen_random_uuid(),'991001 — Тест А'),(gen_random_uuid(),'991002 — Тест Б'),(gen_random_uuid(),'991003 — Другой груз') returning *) select json_agg(inserted order by code) from inserted");
 const [a,b,other]=codes.map(c=>c.id);
 const bill=sql(`select wr.waybill_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wc.id='${rail.waybill_container_id}'`);
 // Empty source cargo must keep the period visible, including cancelled periods.
 sql(`delete from receiving_order_container_item where receiving_order_container_id='${auto.receiving_order_container_id}'; delete from waybill_product where waybill_id='${bill}';`);
 assert.equal((await period(auto.id)).cargoName,undefined);assert.equal((await period(rail.id)).cargoName,undefined);
 // Duplicate products do not duplicate labels or report rows.
 sql(`insert into receiving_order_container_item(id,receiving_order_container_id,etsng_code_id,wight_net) values(gen_random_uuid(),'${auto.receiving_order_container_id}','${a}',1),(gen_random_uuid(),'${auto.receiving_order_container_id}','${b}',1),(gen_random_uuid(),'${auto.receiving_order_container_id}','${a}',1);
 insert into waybill_product(id,waybill_id,etsng_code_id,weight) values(gen_random_uuid(),'${bill}','${b}',1),(gen_random_uuid(),'${bill}','${a}',1),(gen_random_uuid(),'${bill}','${a}',1);`);
 for(const p of [auto,rail])assert.equal((await period(p.id)).cargoName,'991001 — Тест А; 991002 — Тест Б');
 // Another task row in the same receipt must not contribute to this period.
 sql(`insert into receiving_order_container(id,receiving_order_id,container_id,empty) select gen_random_uuid(),'${auto.receiving_order_id}',c.id,true from container c where not exists(select 1 from receiving_order_container r where r.receiving_order_id='${auto.receiving_order_id}' and r.container_id=c.id) limit 1;
 insert into receiving_order_container_item(id,receiving_order_container_id,etsng_code_id,wight_net) select gen_random_uuid(),r.id,'${other}',1 from receiving_order_container r where r.receiving_order_id='${auto.receiving_order_id}' and r.id<>'${auto.receiving_order_container_id}';`);
 assert.equal((await period(auto.id)).cargoName,'991001 — Тест А; 991002 — Тест Б');
 // Renaming ETSNG is immediately reflected, without updating any storage record.
 sql(`update etsng_code set code='991001 — Новое имя' where id='${a}'`);
 for(const p of [auto,rail]){
  assert.equal((await period(p.id)).cargoName,'991001 — Новое имя; 991002 — Тест Б');
  const r=await fetch(base+'/container-storage-periods/export?status=ALL&periodId='+p.id);assert.equal(r.status,200);
  const csv=await r.text();assert.ok(csv.includes('991001 — Новое имя; 991002 — Тест Б'));assert.equal(csv.trim().split('\r\n').length,2);
 }
 assert.deepEqual(json(`select row_to_json(p) from container_storage_period p where id='${auto.id}'`),auto);
 assert.deepEqual(json(`select row_to_json(p) from container_storage_period p where id='${rail.id}'`),rail);
 console.log('PASS: auto/rail exact source, multiple cargo, deduplication, missing cargo, catalogue rename, API/CSV and unchanged periods');
})().catch(e=>{console.error(e);process.exitCode=1;});
