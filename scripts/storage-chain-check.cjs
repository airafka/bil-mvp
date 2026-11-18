// V51 -> V52 preservation. Only read modes may target the working database.
const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_storage_chain_test',docker=process.env.DOCKER_EXE||'docker',mode=process.argv[2];
assert.ok(['billing_storage_chain_test','billing_storage_chain_release_test','billing_storage_chain_perf_test','billing_next'].includes(db));
assert.ok(['capture','verify','api-capture','api-verify','dry-run'].includes(mode));
assert.ok(db!=='billing_next'||mode!=='dry-run');
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');assert.equal(sql('select current_database()'),db);
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));
const file='backups/storage-chain-'+db+'-before.json';
function state(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql("select count(*)||':'||md5(coalesce(string_agg(v::text,chr(10) order by v::text),'')) from (select to_jsonb(t)"+(t==='container_storage_period'?"-'arrival_history_id'":'')+' v from "'+t+'" t)x')]));
 const seq=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 const rows=(table,omit)=>json(`select coalesce(json_agg(v order by v->>'id'),'[]') from (select to_jsonb(t)${omit} v from ${table} t)x`);
 return {hashes,sequences:Object.fromEntries(seq.map(t=>[t,sql('select last_value||\':\'||is_called from "'+t+'"')])),history:rows('container_owner_history_view',''),report:rows('container_storage_period_view',''),origins:rows("(select p.id,storage_arrival_history(p.id) arrival_history_id,storage_receiving_order(p.id) receiving_order_id from container_storage_period p)",''),date:sql('select billing_today()')};
}
if(mode==='capture'){
 assert.equal(schema,51);assert.ok(!fs.existsSync(file));fs.writeFileSync(file,JSON.stringify(state()));
 console.log('PASS: all remaining business fields, sequences, dates, event meanings and complete report captured');
}else if(mode==='verify'){
 assert.ok([52,53].includes(schema));assert.deepEqual(state(),JSON.parse(fs.readFileSync(file)));
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period'"),'7');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name='arrival_history_id'"),'0');
 console.log('PASS: period has seven fields; exact arrivals, all remaining values and complete report unchanged');
}else if(mode==='dry-run'){
 assert.equal(db,'billing_storage_chain_test');assert.equal(schema,51);const before=state();
 const migration=fs.readFileSync('backend/src/main/resources/db/baseline/V52__derive_storage_arrival_from_chain.sql','utf8');
 const physical=sql("select json_agg(to_jsonb(p) order by id) from container_storage_period p");
 const victim=sql("select id from container_storage_period limit 1");
 let rejected=false;try{sql("BEGIN; DROP TRIGGER storage_arrival_immutable ON container_storage_period; UPDATE container_storage_period SET arrival_history_id=start_history_id WHERE id=(SELECT id FROM container_storage_period WHERE start_history_id<>arrival_history_id LIMIT 1); UPDATE container_storage_period SET arrival_history_id=(select id from container_owner_history where id<>container_storage_period.arrival_history_id limit 1) WHERE id='"+victim+"'; "+migration+'; ROLLBACK;');}catch(e){rejected=true;assert.match(String(e.stderr),/Invalid storage origin/);}
 assert.ok(rejected);assert.deepEqual(state(),before);assert.equal(sql("select json_agg(to_jsonb(p) order by id) from container_storage_period p"),physical);
 sql('BEGIN; '+migration+'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;');assert.deepEqual(state(),before);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period'"),'8');
 console.log('PASS: wrong stored arrival aborts atomically; valid migration succeeds and rollback restores full data/schema');
}else{
 const port=({billing_next:'8081',billing_storage_chain_test:'8211',billing_storage_chain_release_test:'8221'})[db];assert.ok(port);
 const container=({billing_next:'billing-next-backend-1',billing_storage_chain_test:'billing-next-storage-chain-test',billing_storage_chain_release_test:'billing-next-storage-chain-release-test'})[db];
 const info=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 (async()=>{
  const data={},ids=json("select json_agg(distinct container_id) from container_owner_history");
  const paths=['/container-storage-periods?size=100','/container-storage-periods?status=CANCELLED','/container-storage-periods/export',...ids.flatMap(id=>['/containers/'+id+'/owner-history?includeReservations=true','/containers/'+id+'/owner-history'])];
  for(const p of paths){const r=await fetch('http://127.0.0.1:'+port+'/api'+p);assert.equal(r.status,200,p);data[p]=crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');}
  const output=file.replace('-before.json','-api-before.json');
  if(mode==='api-capture'){assert.equal(schema,51);assert.ok(!fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(data));}
  else {assert.ok([52,53].includes(schema));assert.deepEqual(data,JSON.parse(fs.readFileSync(output)));}
  console.log('PASS: complete history API (both filters) for every KTK, report API and full CSV '+mode);
 })().catch(e=>{console.error(e);process.exitCode=1;});
}
