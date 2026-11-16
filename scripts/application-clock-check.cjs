// All changes are restricted to a restored billing_clock_test on backend port 8199.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_clock_test',base='http://127.0.0.1:8199/api';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
const sql=q=>run(['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const json=q=>JSON.parse(sql(q));
assert.equal(sql('select current_database()'),db);
const snapshot=path.resolve(__dirname,'../backups/clock-before-tables.json');
function fingerprints(){const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename not in ('flyway_schema_history','application_clock')");return sql(tables.map(t=>`select json_build_object('table','${t}','count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) order by to_jsonb(t)::text),''))) from public."${t}" t`).join(' union all '));}
if(process.argv[2]==='capture') {assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'34');assert.ok(!fs.existsSync(snapshot),'Capture already exists');fs.writeFileSync(snapshot,fingerprints());console.log('Captured pre-migration business rows');process.exit();}
const inspect=JSON.parse(run(['inspect','billing-next-clock-test']))[0];
assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8199'));
assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'35');
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let value;try{value=JSON.parse(text)}catch{value=text}assert.equal(r.status,status,p+': '+text);return value;}
async function date(value){const c=await api('/application-clock');return api('/application-clock','PUT',{date:value,version:c.version});}
const localDate=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date(value));
const finish=(id,section)=>api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section,action:'COMPLETE_ORDERS'});
async function complete(id,section){await api('/comprehensive-service-orders/'+id+'/prepare-transport','POST',{section});await api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section,action:'CONFIRM_ROUTES'});return finish(id,section);}
(async()=>{
 const expectedRows=process.argv[2]==='recheck'?fingerprints():fs.readFileSync(snapshot,'utf8');
 assert.equal(fingerprints(),expectedRows,'Migration changed existing business rows');
 const initial=await api('/application-clock');assert.equal(initial.mode,'SYSTEM');assert.equal(initial.date,localDate(initial.systemNow));assert.ok(Math.abs(Date.now()-Date.parse(initial.now))<5000);
 try {
  let state=await date('2096-02-28');assert.equal(state.date,'2096-02-28');assert.equal(state.mode,'FIXED');
  assert.equal(sql("begin read only; select billing_today(); commit").split('\n')[1],'2096-02-28');
  assert.equal(sql("select abs(extract(epoch from ((billing_now() at time zone 'Europe/Moscow')::time-(clock_timestamp() at time zone 'Europe/Moscow')::time)))<2"),'t');
  assert.equal(fingerprints(),expectedRows,'Changing calendar rewrote existing business rows');
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name not in ('application_clock','flyway_schema_history') and column_default ~* '(current_timestamp|(^|[^_])now\\(\\)|clock_timestamp\\(\\))'"),'0');
  await api('/application-clock','PUT',{date:'2096-02-29',version:initial.version},409);
  await api('/application-clock','PUT',{date:'2096-02-30',version:state.version},400);
  await api('/application-clock','PUT',{date:'2096-02-29'},400);
  const concurrent=await Promise.all(['2096-02-29','2096-03-01'].map(d=>fetch(base+'/application-clock',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:d,version:state.version})})));
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  console.log('PASS: V35 preserves every business row, system time, read-only reports, version conflicts and invalid dates');
  await date('2096-02-28');
  const catalog=(await api('/comprehensive-service-orders/available-services'))[0];
  const tariff=json(`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active and complex_service_id='${catalog.id}' order by id limit 1)t`);
  const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);
  const service=await api('/comprehensive-service-orders','POST',{complexServiceId:catalog.id,clientId:tariff.client_id,contractId:tariff.contract_id,defaultContainerOwnerId:tariff.client_id,waybillIds:[bill.id]},201);
  const id=service.order.id,c=service.receivingOrder.containers[0].containerId,shipping=service.shippingOrders[0].id;
  await api('/comprehensive-service-orders/'+id+'/no-return','POST',{containerIds:[c]});
  await complete(id,'INITIAL_RECEIVING');
  let period=json(`select row_to_json(p) from container_storage_period p where container_id='${c}'`);
  assert.equal(localDate(period.arrival_at),'2096-02-28');assert.equal(localDate(period.created_at),'2096-02-28');
  assert.equal((await api('/container-storage-periods?periodId='+period.id)).items[0].storageDays,1);
  const frozen=sql(`select to_jsonb(p)::text from container_storage_period p where id='${period.id}'`);
  await date('2096-03-01'); // Includes 29 February.
  assert.equal((await api('/container-storage-periods?periodId='+period.id)).items[0].storageDays,3);
  assert.equal(sql(`select to_jsonb(p)::text from container_storage_period p where id='${period.id}'`),frozen);
  await api('/container-storage-periods?asOf=2096-03-02','GET',undefined,400);
  await complete(id,'SHIPPING');
  period=json(`select row_to_json(p) from container_storage_period p where id='${period.id}'`);
  assert.equal(localDate(period.departure_at),'2096-03-01');assert.equal(localDate(period.updated_at),'2096-03-01');
  const execution=json(`select row_to_json(e) from service_execution e where comprehensive_service_order_id='${id}'`);
  assert.equal(localDate(execution.performed_at),'2096-03-01');assert.equal(localDate(execution.priced_at),'2096-03-01');
  assert.equal(sql(`select count(*) from route where id in (select route_id from receiving_order where comprehensive_service_order_id='${id}') and (data_time at time zone 'Europe/Moscow')::date='2096-02-28'`),'1');
  assert.equal(sql(`select count(*) from container_owner_history where container_id='${c}' and (created_at at time zone 'UTC' at time zone 'Europe/Moscow')::date not in ('2096-02-28','2096-03-01')`),'0');
  assert.equal(sql(`select count(*) from container_movement where container_id='${c}' and (event_date_time at time zone 'UTC' at time zone 'Europe/Moscow')::date<>(created_at at time zone 'UTC' at time zone 'Europe/Moscow')::date`),'0');
  await date('2096-03-02');
  assert.equal((await api('/container-storage-periods?periodId='+period.id)).items[0].storageDays,3);
  await api('/shipping-orders/'+shipping+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'Изолированная проверка календаря'});
  assert.equal((await api('/container-storage-periods?periodId='+period.id)).items[0].storageDays,4);
  assert.equal(sql(`select (cancelled_at at time zone 'Europe/Moscow')::date from order_cancellation where order_id='${shipping}'`),'2096-03-02');
  console.log('PASS: created_at, stock UTC timestamps, route plans, receipt/departure, leap-day storage, charges and cancellation use business dates');
  // New shipment after cancellation, then invoice creation and payment on separate working days.
  let details=await api('/comprehensive-service-orders/'+id+'/shipping-orders','POST',{containerIds:[c]},201);
  await date('2096-03-03');await api('/comprehensive-service-orders/'+id+'/no-return','POST',{containerIds:[c]});await complete(id,'SHIPPING');
  const charge=json(`select row_to_json(b) from billing_charge b join service_execution e on e.id=b.service_execution_id where e.comprehensive_service_order_id='${id}'`);
  assert.equal(localDate(charge.created_at),'2096-03-03');
  await date('2096-03-04');
  const invoice=await api('/payment-invoices','POST',{clientId:tariff.client_id,contractId:tariff.contract_id,period:'2096-03',chargeIds:[charge.id],requestKey:crypto.randomUUID()},201);
  assert.equal(localDate(invoice.invoice.createdAt),'2096-03-04');
  await date('2096-03-05');
  const paid=await api('/payment-invoices/'+invoice.invoice.id+'/paid','POST',{version:invoice.invoice.version});
  assert.equal(localDate(paid.invoice.paidAt),'2096-03-05');
  await date('2096-02-27');assert.equal((await api('/container-storage-periods?periodId='+period.id)).totalElements,0);
  assert.equal(localDate((await api('/payment-invoices/'+invoice.invoice.id)).invoice.createdAt),'2096-03-04');
  await date('2096-03-05');
  run(['restart','billing-next-clock-test']);
  let healthy=false;for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:8199/actuator/health');if(r.ok){healthy=true;break}}catch{}await new Promise(r=>setTimeout(r,300));}assert.ok(healthy);
  assert.equal((await api('/application-clock')).date,'2096-03-05');
  fs.writeFileSync(path.resolve(__dirname,'../backups/clock-fixture.json'),JSON.stringify({db,periodId:period.id,containerId:c,serviceId:id,invoiceId:invoice.invoice.id}));
  console.log('PASS: invoice/month/payment dates, rewinding does not rewrite history, selected date survives backend restart');
 } finally {const restored=await date(null);assert.equal(restored.mode,'SYSTEM');assert.equal(restored.date,localDate(restored.systemNow));}
 console.log('PASS: Today restores real date and system mode; test database reset to system mode');
})().catch(e=>{console.error(e);process.exitCode=1});
