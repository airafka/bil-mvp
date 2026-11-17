// V47 migration equivalence and report checks. Mutations belong only to the isolated fixture database.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_storage_origin_test';
assert.ok(['billing_storage_origin_test','billing_storage_origin_release_test','billing_storage_view_test','billing_next'].includes(db));
const mode=process.argv[2],live=db==='billing_next';
assert.ok(!live||['capture','verify'].includes(mode),'Live database is read-only');
const docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');
assert.equal(sql('select current_database()'),db);
const removed=['receiving_order_id'];
const file='backups/storage-origin-'+db+'-before.json';
function state(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const minus=removed.map(c=>" - '"+c+"'").join('');
 const hashes=Object.fromEntries(tables.map(t=>[t,sql("select count(*)||':'||md5(coalesce(string_agg(v::text,chr(10) order by v::text),'')) from (select to_jsonb(t)"+(t==='container_storage_period'?minus:'')+' v from "'+t+'" t)x')]));
 const seq=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 return {hashes,sequences:Object.fromEntries(seq.map(t=>[t,sql('select last_value||\':\'||is_called from "'+t+'"')]))};
}
function rows(query){return json("select coalesce(json_agg(row_to_json(q) order by id),'[]') from ("+query+") q");}
const afterSql="select p.*,greatest(0,(least(coalesce((p.shipping_at at time zone 'Europe/Moscow')::date-case when p.departure_operation_type='OWNER_CHANGE' then 1 else 0 end,DATE '@DATE@'),DATE '@DATE@')-(p.receiving_at at time zone 'Europe/Moscow')::date)+1)::bigint storage_days from container_storage_period_view p";
if(mode==='capture'){
 assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'46');
 assert.ok(!fs.existsSync(file),'Do not overwrite a preservation snapshot');
 const asOf=sql('select billing_today()');
 fs.writeFileSync(file,JSON.stringify({state:state(),origins:rows('select id,receiving_order_id from container_storage_period'),asOf,rows:rows(afterSql.replaceAll('@DATE@',asOf))}));
 console.log('PASS: captured business rows, sequences and all active V46 report values');
}else if(mode==='verify'){
 assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'47');
 const before=JSON.parse(fs.readFileSync(file));
 assert.deepEqual(state(),before.state);
 assert.deepEqual(rows('select * from container_storage_period_origin'),before.origins);
 const actual=rows(afterSql.replaceAll('@DATE@',before.asOf));
 assert.equal(actual.length,before.rows.length);
 for(let i=0;i<actual.length;i++)for(const [key,value]of Object.entries(before.rows[i]))assert.deepEqual(actual[i][key],value,key+' '+actual[i].id);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name in ("+removed.map(c=>"'"+c+"'").join(',')+")"),'0');
 assert.equal(sql("select relkind from pg_class where oid='container_storage_period_view'::regclass"),'v');
 console.log('PASS: receiving_order_id removed; all other business values/sequences and old active report values unchanged');
}else if(mode==='api'){
 const port=db==='billing_storage_origin_release_test'?'8216':'8206';
 const base=(process.env.TEST_API_HOST||'http://127.0.0.1')+':'+port+'/api';
 const info=JSON.parse(execFileSync(docker,['inspect',db==='billing_storage_origin_release_test'?'billing-next-storage-origin-release-test':'billing-next-storage-origin-test'],{encoding:'utf8'}))[0];
 assert.ok(info.Config.Env.includes('DB_NAME='+db));
 const get=async p=>{const r=await fetch(base+p);assert.equal(r.status,200,p);return r.json();};
 (async()=>{
  const asOf=sql('select billing_today()'),expected=rows(afterSql.replaceAll('@DATE@',asOf)+" where (p.receiving_at at time zone 'Europe/Moscow')::date<=DATE '"+asOf+"'");
  const list=await get('/container-storage-periods?status=ALL&size=100');
  assert.equal(list.totalElements,expected.length);
  for(const p of expected){
   const actual=(await get('/container-storage-periods?status=ALL&periodId='+p.id)).items[0];
   assert.equal(Date.parse(actual.arrivalAt),Date.parse(p.receiving_at));
   assert.equal(actual.startOrderId,p.start_order_id);
   assert.equal(actual.endOrderId,p.end_order_id||undefined);
   assert.equal(actual.storageDays,p.storage_days);
   assert.equal(actual.empty,p.is_empty===null?undefined:p.is_empty);
  }
  for(const id of json("select coalesce(json_agg(id),'[]') from container_storage_period where status='CANCELLED'")){
   assert.equal((await get('/container-storage-periods?status=ALL&periodId='+id)).totalElements,0);
   const csv=await(await fetch(base+'/container-storage-periods/export?status=ALL&periodId='+id)).text();
   assert.equal(csv.trim().split('\r\n').length,1);
  }
  assert.equal((await get('/container-storage-periods?status=CANCELLED')).totalElements,0);
  console.log('PASS: API/view dates, ownership order links, days, empty flag, cancelled periods absent from ALL/API/CSV');
 })().catch(e=>{console.error(e);process.exitCode=1;});
}else throw Error('Expected capture, verify or api');
