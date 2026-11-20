// Creates only disposable resources after validating the V59 test environment.
const {run,sql,init}=require('./check-lib.cjs');
const network='billing-storage-read-check',pg='billing-storage-read-db',db='billing_storage_read_test',label='storage-read-v59';
const inspect=n=>JSON.parse(run(['inspect',n]))[0];
async function health(port){for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:'+port+'/actuator/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Health '+port);}
const assert=require('node:assert/strict');
(async()=>{
 await init();
 assert.equal(sql('select current_database()'),db);assert.equal(inspect(pg).Config.Labels['billing.task'],label);assert.ok(inspect(pg).Mounts.every(m=>m.Type==='tmpfs'));
 sql(`CREATE ROLE storage_report_reader LOGIN PASSWORD 'isolated-report-only';
 GRANT USAGE ON SCHEMA public TO storage_report_reader;
 DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'container_owner_history' LOOP
 EXECUTE format('GRANT SELECT ON TABLE public.%I TO storage_report_reader',r.tablename); END LOOP; END $$;`);
 assert.equal(sql("select has_table_privilege('storage_report_reader','container_owner_history','select')"),'f');
 for(const v of ['container_storage_period','container_storage_period_origin','container_storage_period_view','container_owner_history_view','container_owner_current'])assert.equal(sql(`select has_table_privilege('storage_report_reader','${v}','select')`),'f');
 run(['run','-d','--name','billing-storage-read-reader','--label','billing.task='+label,'--network',network,'-p','127.0.0.1:8297:8080','-e','DB_HOST='+pg,'-e','DB_NAME='+db,'-e','DB_USER=storage_report_reader','-e','DB_PASSWORD=isolated-report-only','-e','SPRING_FLYWAY_ENABLED=false','billing-storage-read-backend:check']);
 await health(8297);
 async function fetchText(port,suffix){const r=await fetch(`http://127.0.0.1:${port}/api/container-storage-periods${suffix}`);const body=await r.text();assert.equal(r.status,200,suffix+': '+body);return body;}
 const suffixes=['?size=100','?status=ALL','?status=CANCELLED','?status=OPEN','?status=CLOSED','/containers','/visits?size=100','/export','/export?status=CLOSED','/visits?asOf=2026-09-16','/export?asOf=2026-09-17','?arrivalFrom=2026-09-15&arrivalTo=2026-09-24'];
 const row=JSON.parse(await fetchText(8296,'?size=1')).items[0];assert.ok(row);suffixes.push('?periodId='+row.id,'/visits?periodId='+row.id,'/export?periodId='+row.id);
 const client=sql('select client_id from receiving_order order by id limit 1');suffixes.push('?clientId='+client,'/export?clientId='+client);
 for(const p of suffixes)assert.equal(await fetchText(8297,p),await fetchText(8296,p));
 console.log('PASS '+suffixes.length+' report/CSV/visits/filter requests with no SELECT permission on history or legacy views');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
