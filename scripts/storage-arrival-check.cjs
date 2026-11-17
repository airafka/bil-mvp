// V47 -> V48 preservation. Live modes only read; integrity mutations always roll back on the isolated test DB.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process'),crypto=require('crypto');
const db=process.env.STORAGE_TEST_DB||'billing_storage_arrival_test',docker=process.env.DOCKER_EXE||'docker',mode=process.argv[2];
assert.ok(['billing_history_cancellation_test','billing_history_metadata_test','billing_history_operation_test','billing_storage_arrival_test','billing_storage_arrival_release_test','billing_storage_view_test','billing_next'].includes(db));
assert.ok(db!=='billing_next'||['capture','verify','api-capture','api-verify'].includes(mode));
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');
assert.equal(sql('select current_database()'),db);
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));
const file='backups/storage-arrival-'+db+'-before.json';
const normalized=alias=>schema>=48?`(to_jsonb(${alias})-'arrival_history_id')`:`((to_jsonb(${alias})-'receiving_history_id'-'shipping_history_id')||jsonb_build_object('start_history_id',${alias}.receiving_history_id,'end_history_id',${alias}.shipping_history_id))`;
function state(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql("select count(*)||':'||md5(coalesce(string_agg(v::text,chr(10) order by v::text),'')) from (select "+(t==='container_storage_period'?normalized('t'):'to_jsonb(t)')+' v from "'+t+'" t)x')]));
 const seq=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 return {hashes,sequences:Object.fromEntries(seq.map(t=>[t,sql('select last_value||\':\'||is_called from "'+t+'"')]))};
}
const rows=q=>json("select coalesce(json_agg(q order by id),'[]') from ("+q+") q");
function origins(){
 if(schema>=48)return rows('select p.id,p.arrival_history_id,h.order_id receiving_order_id from container_storage_period p join container_owner_history h on h.id=p.arrival_history_id');
 return rows(`WITH RECURSIVE chain(id,container_id,end_id,arrival_history_id,receiving_order_id) AS (
 SELECT p.id,p.container_id,p.shipping_history_id,h.id,h.order_id FROM container_storage_period p JOIN container_owner_history h ON h.id=p.receiving_history_id WHERE h.operation_type='ARRIVAL' AND NOT h.cancellation
 UNION SELECT p.id,p.container_id,p.shipping_history_id,c.arrival_history_id,c.receiving_order_id FROM chain c JOIN container_storage_period p ON p.receiving_history_id=c.end_id AND p.container_id=c.container_id JOIN container_owner_history h ON h.id=p.receiving_history_id WHERE h.operation_type='OWNER_CHANGE' AND NOT h.cancellation)
 SELECT id,arrival_history_id,receiving_order_id FROM chain`);
}
const report=()=>json("select coalesce(json_agg("+normalized('v')+" order by id),'[]') from container_storage_period_view v");
if(mode==='capture'){
 assert.equal(schema,47);assert.ok(!fs.existsSync(file),'Preservation snapshot already exists');
 const before={state:state(),origins:origins(),report:report(),asOf:sql('select billing_today()')};
 assert.equal(before.origins.length,Number(sql('select count(*) from container_storage_period')));
 fs.writeFileSync(file,JSON.stringify(before));console.log('PASS: V47 all business rows/sequences, exact arrivals (including cancelled), active report captured');
}else if(mode==='verify'){
 assert.equal(schema,48);const before=JSON.parse(fs.readFileSync(file));
 assert.deepEqual(state(),before.state);assert.deepEqual(origins(),before.origins);assert.deepEqual(report(),before.report);assert.equal(sql('select billing_today()'),before.asOf);
 assert.deepEqual(json("select json_agg(column_name order by column_name) from information_schema.columns where table_schema='public' and table_name='container_storage_period'"),['arrival_history_id','container_id','created_at','end_history_id','id','start_history_id','status','updated_at']);
 assert.equal(sql("select count(*) from container_storage_period where storage_arrival_history(id)<>arrival_history_id"),'0');
 console.log('PASS: eight columns; all business data, sequence values, exact arrivals and complete report preserved');
}else if(mode==='integrity'){
 assert.ok(['billing_storage_arrival_test','billing_history_operation_test','billing_history_metadata_test','billing_history_cancellation_test'].includes(db));assert.ok([48,49,50,51].includes(schema));
 const f=JSON.parse(fs.readFileSync('backups/storage-owner-fixtures.json'));assert.equal(f.db,db);
 const p=json("select row_to_json(p) from container_storage_period p where id='"+f.periodId+"'");
 function rejected(q,pattern=/Invalid storage|violates.*constraint|duplicate key|cannot be null/){let failed=false;try{sql("BEGIN; SET LOCAL statement_timeout='5s'; "+q+"; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;");}catch(e){failed=true;assert.match(String(e.stderr),pattern);}assert.ok(failed,'Invalid data accepted');}
 rejected("update container_storage_period set arrival_history_id=null where id='"+p.id+"'");
 rejected("update container_storage_period set arrival_history_id=start_history_id where id='"+p.id+"'");
 rejected("update container_storage_period set arrival_history_id=gen_random_uuid() where id='"+p.id+"'");
 rejected("update container_storage_period set arrival_history_id=(select arrival_history_id from container_storage_period where container_id<>'"+p.container_id+"' limit 1) where id='"+p.id+"'");
 rejected("delete from container_storage_period where id='"+f.previousPeriodId+"'");
 rejected("delete from receiving_order where id='"+f.receivingId+"'",/Invalid storage origin: receiving order is referenced/);
 rejected("update receiving_order set id=gen_random_uuid() where id='"+f.receivingId+"'",/Invalid storage origin: receiving order is referenced/);
 rejected((schema>=49?"update container_owner_history set order_type='SERVICE_ORDER',old_status='ON_TERMINAL',new_status='ON_TERMINAL' where id='":"update container_owner_history set operation_type='OWNER_CHANGE' where id='")+p.arrival_history_id+"'");
 // A new period must use its own true ARRIVAL, even when another valid event exists.
 const foreignArrival=sql("select arrival_history_id from container_storage_period where container_id<>'"+p.container_id+"' limit 1");
 for(const wrongArrival of [p.arrival_history_id,p.start_history_id,foreignArrival]){
  rejected(`
   CREATE TEMP TABLE wrong_origin AS SELECT gen_random_uuid() p,gen_random_uuid() event_id;
   INSERT INTO container_owner_history SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object('id',m.event_id,'storage_period_id',null))).* FROM wrong_origin m CROSS JOIN container_owner_history h WHERE h.id='${p.arrival_history_id}';
   INSERT INTO container_storage_period(id,container_id,arrival_history_id,start_history_id,status) SELECT m.p,h.container_id,'${wrongArrival}'::uuid,m.event_id,'CANCELLED' FROM wrong_origin m JOIN container_owner_history h ON h.id=m.event_id;
   UPDATE container_owner_history h SET storage_period_id=m.p FROM wrong_origin m WHERE h.id=m.event_id
  `,/Invalid storage origin: arrival differs from chain/);
 }
 rejected(`
 CREATE TEMP TABLE cycle_ids AS SELECT gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() h1,gen_random_uuid() h2;
 INSERT INTO container_owner_history SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object('id',m.h1,'storage_period_id',null,'occurred_at',timestamptz '2026-11-22 12:00+03'))).* FROM cycle_ids m CROSS JOIN container_owner_history h WHERE h.id='${p.start_history_id}';
 INSERT INTO container_owner_history SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object('id',m.h2,'storage_period_id',null,'old_client_id',h.new_client_id,'new_client_id',h.old_client_id))).* FROM cycle_ids m JOIN container_owner_history h ON h.id=m.h1;
 INSERT INTO container_storage_period(id,container_id,arrival_history_id,start_history_id,end_history_id,status)
 SELECT m.p1,h.container_id,'${p.arrival_history_id}'::uuid,m.h1,m.h2,'CANCELLED' FROM cycle_ids m JOIN container_owner_history h ON h.id=m.h1
 UNION ALL SELECT m.p2,h.container_id,'${p.arrival_history_id}'::uuid,m.h2,m.h1,'CANCELLED' FROM cycle_ids m JOIN container_owner_history h ON h.id=m.h2;
 UPDATE container_owner_history h SET storage_period_id=case when h.id=m.h1 then m.p1 else m.p2 end FROM cycle_ids m WHERE h.id in(m.h1,m.h2)
 `,/Invalid storage origin chain.*cycle/);
 rejected(`
 CREATE TEMP TABLE detached AS SELECT gen_random_uuid() p,gen_random_uuid() event_id;
 INSERT INTO container_owner_history SELECT (jsonb_populate_record(null::container_owner_history,to_jsonb(h)||jsonb_build_object('id',m.event_id,'storage_period_id',null))).* FROM detached m CROSS JOIN container_owner_history h WHERE h.id='${p.start_history_id}';
 INSERT INTO container_storage_period(id,container_id,arrival_history_id,start_history_id,status) SELECT m.p,h.container_id,'${p.arrival_history_id}',m.event_id,'CANCELLED' FROM detached m JOIN container_owner_history h ON h.id=m.event_id;
 UPDATE container_owner_history h SET storage_period_id=m.p FROM detached m WHERE h.id=m.event_id
 `,/Invalid storage origin chain.*missing predecessor/);
 assert.equal(sql("select count(*) from container_storage_period where storage_arrival_history(id)<>arrival_history_id"),'0');
 const cancelled=json("select row_to_json(p) from container_storage_period p where status='CANCELLED' limit 1");assert.ok(cancelled);
 rejected("update container_storage_period set arrival_history_id=gen_random_uuid() where id='"+cancelled.id+"'");
 rejected("delete from receiving_order where id=storage_receiving_order('"+cancelled.id+"')",/Invalid storage origin: receiving order is referenced/);
 console.log('PASS: immutable arrivals, null/wrong/foreign events, cycles, disconnected chains, deleted root and receipt keys rejected, including cancelled visits');
}else if(['api-capture','api-verify'].includes(mode)){
 const port=process.env.TEST_API_PORT||({billing_next:'8081',billing_storage_arrival_test:'8207',billing_storage_arrival_release_test:'8217',billing_storage_view_test:'8225'})[db];
 const container=process.env.TEST_BACKEND_CONTAINER||({billing_next:'billing-next-backend-1',billing_storage_arrival_test:'billing-next-storage-arrival-test',billing_storage_arrival_release_test:'billing-next-storage-arrival-release-test',billing_storage_view_test:'billing-next-storage-origin-perf-test'})[db];
 const inspect=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 const base='http://127.0.0.1:'+port+'/api/container-storage-periods',out=file.replace('-before.json','-api-before.json');
 (async()=>{
 const data={};for(const suffix of ['?size=20','?size=20&page=250','?status=CANCELLED','/export']){const r=await fetch(base+suffix);assert.equal(r.status,200);data[suffix]=crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');}
 if(mode==='api-capture'){assert.equal(schema,47);assert.ok(!fs.existsSync(out));fs.writeFileSync(out,JSON.stringify(data));}
 else {assert.equal(schema,48);assert.deepEqual(data,JSON.parse(fs.readFileSync(out)));}
 console.log('PASS: API first/deep page, cancelled filter and complete CSV '+mode);
 })().catch(e=>{console.error(e);process.exitCode=1;});
}else throw Error('Expected capture, verify, integrity, api-capture or api-verify');
