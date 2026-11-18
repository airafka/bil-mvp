// Read-only EXPLAIN and API timings after storage-view-perf-fixture.sql, on the isolated database only.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_storage_view_test',docker=process.env.DOCKER_EXE||'docker';
assert.ok(['billing_storage_view_test','billing_storage_chain_perf_test'].includes(db));
const outputPrefix=process.env.STORAGE_PERF_PREFIX||'storage-view';assert.match(outputPrefix,/^[a-z-]+$/);
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
const json=q=>JSON.parse(sql(q));assert.equal(sql('select current_database()'),db);
assert.ok(Number(sql("select count(*) from container where code like 'VIEU%'"))>=10000);
if(db==='billing_storage_chain_perf_test'){
 const info=JSON.parse(execFileSync(docker,['inspect','billing-next-storage-chain-perf-test'],{encoding:'utf8'}))[0];
 assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8212'));
 assert.equal(process.env.TEST_API_PORT,'8212');
}
const asOf=sql('select billing_today()');
const select="select p.*,greatest(0,(least(coalesce((p.shipping_at at time zone 'Europe/Moscow')::date-case when p.departure_operation_type='OWNER_CHANGE' then 1 else 0 end,DATE '"+asOf+"'),DATE '"+asOf+"')-(p.receiving_at at time zone 'Europe/Moscow')::date)+1)::bigint storage_days from container_storage_period_view p";
const where=" where (p.receiving_at at time zone 'Europe/Moscow')::date<=DATE '"+asOf+"'";
const queries={
 page20:select+where+' order by p.receiving_at desc,p.id limit 20',
 count:"select count(*) from ("+select+where+") q",
 filtered:select+where+" and p.status='OPEN' and p.receiving_at>=timestamptz '2025-10-01 00:00:00+03' order by p.receiving_at desc,p.id limit 20",
 deepPage:select+where+' order by p.receiving_at desc,p.id limit 20 offset 5000',
 export:select+where+' order by p.receiving_at desc,p.id'
};
const summary={periods:Number(sql("select count(*) from container_storage_period_view")),schema:Number(sql('select max(version::int) from flyway_schema_history where success')),queries:{},api:{}};
function stats(a){a.sort((x,y)=>x-y);return {minMs:a[0],medianMs:a[Math.floor(a.length/2)],maxMs:a.at(-1)};}
for(const [name,q]of Object.entries(queries)){
 json('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q); // Warm up before the five measured reads.
 const plans=Array.from({length:5},()=>json('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q)[0]);
 fs.writeFileSync('backups/'+outputPrefix+'-plan-'+name+'.json',JSON.stringify(plans.at(-1),null,2));
 summary.queries[name]=stats(plans.map(p=>p['Execution Time']));
 summary.queries[name].rows=plans.at(-1).Plan['Actual Rows'];
 console.log(name,summary.queries[name]);
}
(async()=>{
 const base=(process.env.TEST_API_HOST||'http://127.0.0.1')+':'+(process.env.TEST_API_PORT||'8204')+'/api/container-storage-periods';
 for(const [name,path]of Object.entries({page20:'?size=20',deepPage:'?size=20&page=250',export:'/export'})){
  const warm=await fetch(base+path);assert.equal(warm.status,200);await warm.arrayBuffer();
   const times=[];for(let i=0;i<5;i++){const start=performance.now(),r=await fetch(base+path);assert.equal(r.status,200);await r.arrayBuffer();times.push(performance.now()-start);}
  summary.api[name]=stats(times);console.log('API '+name,summary.api[name]);
 }
 fs.writeFileSync('backups/'+outputPrefix+'-performance.json',JSON.stringify(summary,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

