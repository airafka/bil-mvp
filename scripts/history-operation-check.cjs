// V48 -> V49 preservation and exhaustive transition classification. Mutations are isolated and rolled back.
const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_history_operation_test',docker=process.env.DOCKER_EXE||'docker',mode=process.argv[2];
assert.ok(['billing_history_metadata_test','billing_history_operation_test','billing_history_operation_release_test','billing_history_operation_migration_test','billing_next'].includes(db));
assert.ok(db!=='billing_next'||['capture','verify','api-capture','api-verify'].includes(mode),'Live database is read-only');
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');assert.equal(sql('select current_database()'),db);
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));
const file='backups/history-operation-'+db+'-before.json',source=schema>=49?'container_owner_history_view':'container_owner_history';
const rows=t=>json("select coalesce(json_agg(t order by id),'[]') from "+t+' t');
function state(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql("select count(*)||':'||md5(coalesce(string_agg(v::text,chr(10) order by v::text),'')) from (select to_jsonb(t)"+(t==='container_owner_history'?"-'operation_type'":'')+' v from "'+t+'" t)x')]));
 const seq=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 return {hashes,sequences:Object.fromEntries(seq.map(t=>[t,sql('select last_value||\':\'||is_called from "'+t+'"')]))};
}
const cases=[
 ['RECEIVING_ORDER',null,'EXPECTED','RESERVE_RECEIVING'],['RECEIVING_ORDER','DEPARTED','EXPECTED','RESERVE_RECEIVING'],
 ['RECEIVING_ORDER','EXPECTED','ON_TERMINAL','ARRIVAL'],['RECEIVING_ORDER','EXPECTED','DEPARTED','CANCEL_RECEIVING_RESERVATION'],['RECEIVING_ORDER','ON_TERMINAL','DEPARTED','CANCEL_ARRIVAL'],
 ['SHIPPING_ORDER','ON_TERMINAL','RESERVED_OUT','RESERVE_SHIPPING'],['SHIPPING_ORDER','RESERVED_OUT','DEPARTED','DEPARTURE'],['SHIPPING_ORDER','RESERVED_OUT','ON_TERMINAL','CANCEL_SHIPPING_RESERVATION'],['SHIPPING_ORDER','DEPARTED','ON_TERMINAL','CANCEL_DEPARTURE'],
 ...['EXPECTED','ON_TERMINAL','RESERVED_OUT','DEPARTED'].map(s=>['SERVICE_ORDER',s,s,'OWNER_CHANGE'])
];
const key=(a,b,c)=>JSON.stringify([a,b,c]),mapping=new Map(cases.map(([a,b,c,d])=>[key(a,b,c),d]));
const quote=s=>s===null?'NULL':"'"+s+"'";
function audit(){
 for(const h of rows(source)){
  const expected=mapping.get(key(h.order_type,h.old_status,h.new_status));
  assert.ok(expected,'Unknown historical transition '+h.id);assert.equal(h.operation_type,expected,h.id);
  assert.equal(h.cancellation,expected.startsWith('CANCEL_'),h.id);
 }
}
function rejected(q,pattern){let failed=false;try{sql("BEGIN; SET LOCAL statement_timeout='10s'; "+q+"; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;");}catch(e){failed=true;assert.match(String(e.stderr),pattern);}assert.ok(failed,'Invalid operation accepted');}
if(mode==='capture'){
 assert.equal(schema,48);assert.ok(!fs.existsSync(file));audit();
 fs.writeFileSync(file,JSON.stringify({state:state(),history:rows(source),report:rows('container_storage_period_view'),origins:rows('container_storage_period_origin'),asOf:sql('select billing_today()')}));
 console.log('PASS: every old event agrees with transition mapping; all business values, sequences, complete history and report captured');
}else if(mode==='verify'){
 assert.equal(schema,49);const before=JSON.parse(fs.readFileSync(file));
 assert.deepEqual(state(),before.state);assert.deepEqual(rows(source),before.history);assert.deepEqual(rows('container_storage_period_view'),before.report);assert.deepEqual(rows('container_storage_period_origin'),before.origins);assert.equal(sql('select billing_today()'),before.asOf);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history' and column_name='operation_type'"),'0');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history'"),'17');audit();
 console.log('PASS: operation_type removed; all remaining data/sequences, every historical event meaning, origins and complete report unchanged');
}else if(mode==='matrix'){
 assert.ok(['billing_history_operation_test','billing_history_metadata_test'].includes(db));assert.ok([49,50].includes(schema));
 const states=[null,'EXPECTED','ON_TERMINAL','RESERVED_OUT','DEPARTED'];
 const values=['RECEIVING_ORDER','SHIPPING_ORDER','SERVICE_ORDER'].flatMap(a=>states.flatMap(b=>states.map(c=>'('+[a,b,c].map(quote).join(',')+')'))).join(',');
 const result=json(`select json_agg(t) from (select kind,old_status,new_status,history_operation_type(kind,old_status,new_status) operation from (values ${values})v(kind,old_status,new_status))t`);
 for(const r of result)assert.equal(r.operation,mapping.get(key(r.kind,r.old_status,r.new_status))||null);
 assert.equal(result.filter(r=>r.operation!==null).length,13);assert.equal(result.length,75);
 assert.equal(sql("select history_operation_type('UNKNOWN','EXPECTED','ON_TERMINAL') is null and history_operation_type('RECEIVING_ORDER','UNKNOWN','ON_TERMINAL') is null and history_operation_type(NULL,'EXPECTED','ON_TERMINAL') is null"),'t');
 const template=json("select row_to_json(h) from container_owner_history h where storage_period_id is null limit 1");assert.ok(template);
 const insert=(r,cancel)=>`INSERT INTO container_owner_history SELECT (jsonb_populate_record(null::container_owner_history,'${JSON.stringify({...template,id:crypto.randomUUID(),order_type:r.kind,old_status:r.old_status,new_status:r.new_status,cancellation:cancel,storage_period_id:null}).replaceAll("'","''")}'::jsonb)).*`;
 for(const r of result){
  if(r.operation===null)rejected(insert(r,false),/history_transition_known/);
  else {
   sql('BEGIN; '+insert(r,r.operation.startsWith('CANCEL_'))+'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;');
   rejected(insert(r,!r.operation.startsWith('CANCEL_')),/history_cancellation_matches_transition/);
  }
 }
 audit();console.log('PASS: all 75 combinations checked; 13 valid transitions accepted, 62 invalid rejected; cancellation consistency enforced');
}else if(mode==='migration-rejection'){
 assert.equal(db,'billing_history_operation_migration_test');assert.equal(schema,48);
 const before=state(),history=rows(source),migration=fs.readFileSync('backend/src/main/resources/db/baseline/V49__derive_history_operation_type.sql','utf8');
 const id=sql("select id from container_owner_history where operation_type='RESERVE_RECEIVING' and storage_period_id is null limit 1");assert.ok(id);
 for(const change of ["operation_type='UNKNOWN'","old_status='UNKNOWN'","cancellation=not cancellation"]){
  rejected("UPDATE container_owner_history SET "+change+" WHERE id='"+id+"';\n"+migration,/History operation is not derivable without changing existing meaning/);
  assert.deepEqual(state(),before);assert.deepEqual(rows(source),history);
  assert.equal(sql("select count(*) from pg_proc where proname='history_operation_type'"),'0');
  assert.equal(sql("select count(*) from information_schema.columns where table_name='container_owner_history' and table_schema='public' and column_name='operation_type'"),'1');
 }
 console.log('PASS: differing legacy meaning, unknown transition and conflicting cancellation abort V49 atomically');
}else if(['api-capture','api-verify'].includes(mode)){
 const port=({billing_next:'8081',billing_history_operation_test:'8208',billing_history_operation_release_test:'8218'})[db];assert.ok(port);
 const container=({billing_next:'billing-next-backend-1',billing_history_operation_test:'billing-next-history-operation-test',billing_history_operation_release_test:'billing-next-history-operation-release-test'})[db];
 const info=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 (async()=>{
  const data={},ids=json("select json_agg(distinct container_id) from container_owner_history");
  const paths=['/container-storage-periods?size=100','/container-storage-periods?status=CANCELLED','/container-storage-periods/export',...ids.flatMap(id=>['/containers/'+id+'/owner-history?includeReservations=true','/containers/'+id+'/owner-history'])];
  for(const p of paths){const r=await fetch('http://127.0.0.1:'+port+'/api'+p);assert.equal(r.status,200,p);data[p]=crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');}
  const output=file.replace('-before.json','-api-before.json');
  if(mode==='api-capture'){assert.equal(schema,48);assert.ok(!fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(data));}
  else {assert.equal(schema,49);assert.deepEqual(data,JSON.parse(fs.readFileSync(output)));}
  console.log('PASS: complete history API (both filters) for every KTK, report API and full CSV '+mode);
 })().catch(e=>{console.error(e);process.exitCode=1;});
}else if(mode==='coverage'){
 assert.ok(['billing_history_operation_test','billing_history_metadata_test'].includes(db));assert.ok([49,50].includes(schema));audit();
 const actual=json('select json_agg(t) from (select distinct order_type,old_status,new_status from container_owner_history)t');
 assert.equal(new Set(actual.map(r=>key(r.order_type,r.old_status,r.new_status))).size,13);
 console.log('PASS: application lifecycle exercised all 13 valid transition combinations; all stored history meanings agree');
}else throw Error('Expected capture, verify, matrix, migration-rejection, api-capture, api-verify or coverage');
