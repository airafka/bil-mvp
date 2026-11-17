// V49 -> V50 preservation. Only read modes may target the working database.
const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_history_metadata_test',docker=process.env.DOCKER_EXE||'docker',mode=process.argv[2];
assert.ok(['billing_history_metadata_test','billing_history_metadata_release_test','billing_next'].includes(db));
assert.ok(['capture','verify','api-capture','api-verify','dry-run'].includes(mode));
assert.ok(db!=='billing_next'||mode!=='dry-run');
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');assert.equal(sql('select current_database()'),db);
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));
const file='backups/history-metadata-'+db+'-before.json';
function state(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql("select count(*)||':'||md5(coalesce(string_agg(v::text,chr(10) order by v::text),'')) from (select to_jsonb(t)"+(t==='container_owner_history'?"-'terminal_area_id'-'time_source'":'')+' v from "'+t+'" t)x')]));
 const seq=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 const rows=(table,omit)=>json(`select coalesce(json_agg(v order by v->>'id'),'[]') from (select to_jsonb(t)${omit} v from ${table} t)x`);
 return {hashes,sequences:Object.fromEntries(seq.map(t=>[t,sql('select last_value||\':\'||is_called from "'+t+'"')])),history:rows('container_owner_history_view',"-'terminal_area_id'-'time_source'"),report:rows('container_storage_period_view',"-'terminal_area_id'-'area_name'-'arrival_time_source'-'departure_time_source'"),origins:rows('container_storage_period_origin',''),date:sql('select billing_today()')};
}
if(mode==='capture'){
 assert.equal(schema,49);assert.ok(!fs.existsSync(file));fs.writeFileSync(file,JSON.stringify(state()));
 console.log('PASS: all remaining business fields, sequences, dates, event meanings and complete report captured');
}else if(mode==='verify'){
 assert.equal(schema,50);assert.deepEqual(state(),JSON.parse(fs.readFileSync(file)));
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history'"),'15');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name in ('container_owner_history','container_owner_history_view','container_storage_period_view') and column_name in ('time_source','terminal_area_id','area_name','arrival_time_source','departure_time_source')"),'0');
 console.log('PASS: history has 15 fields; removed metadata absent from both views; every remaining value and report row unchanged');
}else if(mode==='dry-run'){
 assert.equal(db,'billing_history_metadata_test');assert.equal(schema,49);const before=state();
 const migration=fs.readFileSync('backend/src/main/resources/db/baseline/V50__remove_history_area_and_time_source.sql','utf8');
 sql('BEGIN; '+migration+'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;');assert.deepEqual(state(),before);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history'"),'17');
 console.log('PASS: complete migration and boundary validations succeed; rollback restores original schema and data');
}else{
 const port=({billing_next:'8081',billing_history_metadata_test:'8209',billing_history_metadata_release_test:'8219'})[db];
 const container=({billing_next:'billing-next-backend-1',billing_history_metadata_test:'billing-next-history-metadata-test',billing_history_metadata_release_test:'billing-next-history-metadata-release-test'})[db];
 const info=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 // Only the explicitly removed API keys and the CSV area column are excluded from comparison.
 const removed=new Set(['timeSource','arrivalTimeSource','departureTimeSource','terminalAreaName']);
 function normalized(v){if(Array.isArray(v))return v.map(normalized);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!removed.has(k)).map(([k,x])=>[k,normalized(x)]));return v;}
 function checkAbsent(v){if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){assert.ok(!removed.has(k),k);checkAbsent(x);}}
 function csvRows(s){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===';'&&!quoted){row.push(value);value='';}else if(c==='\n'&&!quoted){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';}else value+=c;}assert.ok(!quoted);if(value||row.length){row.push(value);rows.push(row);}return rows;}
 (async()=>{
  assert.equal(schema,mode==='api-capture'?49:50);const data={};
  const ids=json('select json_agg(distinct container_id) from container_owner_history');
  const paths=['/container-storage-periods?size=100','/container-storage-periods?status=CANCELLED','/container-storage-periods/export',...ids.flatMap(id=>['/containers/'+id+'/owner-history?includeReservations=true','/containers/'+id+'/owner-history'])];
  for(const p of paths){const r=await fetch('http://127.0.0.1:'+port+'/api'+p);assert.equal(r.status,200,p);let v;
   if(p.endsWith('/export')){v=csvRows(await r.text());const index=v[0].indexOf('Площадка');if(schema===49){assert.ok(index>=0);v=v.map(row=>row.filter((_,i)=>i!==index));}else assert.equal(index,-1);}
   else {v=await r.json();if(schema===50)checkAbsent(v);v=normalized(v);}
   data[p]=crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  }
  const output=file.replace('-before.json','-api-before.json');
  if(mode==='api-capture'){assert.ok(!fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(data));}else assert.deepEqual(data,JSON.parse(fs.readFileSync(output)));
  console.log('PASS: every container history, report API and full CSV unchanged except explicitly removed metadata/area');
 })().catch(e=>{console.error(e);process.exitCode=1;});
}
