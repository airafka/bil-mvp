// V50 -> V51 preservation. Only read modes may target the working database.
const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_history_cancellation_test',docker=process.env.DOCKER_EXE||'docker',mode=process.argv[2];
assert.ok(['billing_history_cancellation_test','billing_history_cancellation_release_test','billing_next'].includes(db));
assert.ok(['capture','verify','api-capture','api-verify','dry-run'].includes(mode));
assert.ok(db!=='billing_next'||mode!=='dry-run');
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');assert.equal(sql('select current_database()'),db);
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));
const file='backups/history-cancellation-'+db+'-before.json';
function state(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql("select count(*)||':'||md5(coalesce(string_agg(v::text,chr(10) order by v::text),'')) from (select to_jsonb(t)"+(t==='container_owner_history'?"-'cancellation'":'')+' v from "'+t+'" t)x')]));
 const seq=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 const rows=(table,omit)=>json(`select coalesce(json_agg(v order by v->>'id'),'[]') from (select to_jsonb(t)${omit} v from ${table} t)x`);
 return {hashes,sequences:Object.fromEntries(seq.map(t=>[t,sql('select last_value||\':\'||is_called from "'+t+'"')])),history:rows('container_owner_history_view',''),report:rows('container_storage_period_view',''),origins:rows('container_storage_period_origin',''),date:sql('select billing_today()')};
}
if(mode==='capture'){
 assert.equal(schema,50);assert.ok(!fs.existsSync(file));fs.writeFileSync(file,JSON.stringify(state()));
 console.log('PASS: all remaining business fields, sequences, dates, event meanings and complete report captured');
}else if(mode==='verify'){
 assert.equal(schema,51);assert.deepEqual(state(),JSON.parse(fs.readFileSync(file)));
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history'"),'14');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history' and column_name='cancellation'"),'0');
 console.log('PASS: history has 14 fields; cancellation is computed; every historical flag, remaining value and report row unchanged');
}else if(mode==='dry-run'){
 assert.equal(db,'billing_history_cancellation_test');assert.equal(schema,50);const before=state();
 const migration=fs.readFileSync('backend/src/main/resources/db/baseline/V51__derive_history_cancellation.sql','utf8');
 const flags=sql("select json_agg(to_jsonb(h) order by id) from container_owner_history h");
 const victim=sql("select id from container_owner_history where storage_period_id is null limit 1");assert.ok(victim);
 let rejected=false;try{sql("BEGIN; ALTER TABLE container_owner_history DROP CONSTRAINT history_cancellation_matches_transition; UPDATE container_owner_history SET cancellation=not cancellation WHERE id='"+victim+"'; "+migration+'; ROLLBACK;');}catch(e){rejected=true;assert.match(String(e.stderr),/History cancellation cannot be derived without changing existing meaning/);}
 assert.ok(rejected);assert.deepEqual(state(),before);assert.equal(sql("select json_agg(to_jsonb(h) order by id) from container_owner_history h"),flags);
 assert.equal(sql("select count(*) from pg_constraint where conrelid='container_owner_history'::regclass and conname='history_cancellation_matches_transition'"),'1');
 sql('BEGIN; '+migration+'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;');assert.deepEqual(state(),before);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history'"),'15');
 console.log('PASS: contradictory legacy cancellation aborts atomically; valid migration succeeds and rollback restores full data/schema');
}else{
 const port=({billing_next:'8081',billing_history_cancellation_test:'8210',billing_history_cancellation_release_test:'8220'})[db];assert.ok(port);
 const container=({billing_next:'billing-next-backend-1',billing_history_cancellation_test:'billing-next-history-cancellation-test',billing_history_cancellation_release_test:'billing-next-history-cancellation-release-test'})[db];
 const info=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 (async()=>{
  const data={},ids=json("select json_agg(distinct container_id) from container_owner_history");
  const paths=['/container-storage-periods?size=100','/container-storage-periods?status=CANCELLED','/container-storage-periods/export',...ids.flatMap(id=>['/containers/'+id+'/owner-history?includeReservations=true','/containers/'+id+'/owner-history'])];
  for(const p of paths){const r=await fetch('http://127.0.0.1:'+port+'/api'+p);assert.equal(r.status,200,p);data[p]=crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');}
  const output=file.replace('-before.json','-api-before.json');
  if(mode==='api-capture'){assert.equal(schema,50);assert.ok(!fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(data));}
  else {assert.equal(schema,51);assert.deepEqual(data,JSON.parse(fs.readFileSync(output)));}
  console.log('PASS: complete history API (both filters) for every KTK, report API and full CSV '+mode);
 })().catch(e=>{console.error(e);process.exitCode=1;});
}
