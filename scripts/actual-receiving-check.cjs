const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',pg='billing-actual-receiving-db',db='billing_actual_receiving_test',base='http://127.0.0.1:8335/api';
const run=(a,input)=>execFileSync(docker,a,{input,encoding:'utf8',windowsHide:true,maxBuffer:80*1024*1024}).trim();
const sql=q=>run(['exec','-i',pg,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q),json=q=>JSON.parse(sql(q));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
async function init(name){const i=JSON.parse(run(['inspect',name]))[0];assert.ok(i.Config.Env.includes('DB_NAME='+db));assert.ok(i.Config.Env.includes('DB_HOST=db'));assert.deepEqual(Object.keys(i.NetworkSettings.Networks),['billing-actual-receiving']);assert.equal(i.Config.Labels['billing.task'],'actual-receiving');assert.ok(i.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8335'));assert.equal(sql('select current_database()'),db);
const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
const clients=await api('/references/clients'),a=tariff.client_id,[b,c]=clients.filter(x=>x.id!==a).slice(0,2).map(x=>x.id),party=clients.find(x=>x.id===a).name;
const area=(await api('/references/terminal-areas')).find(x=>x.code==='CONTAINER').id;
const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true'))),logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
async function generated(){const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);return sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}' limit 1`);}
async function transport(kind,ktk,owner=a){return api('/'+kind+'-orders','POST',{clientId:a,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',arrivalAt:'2026-09-15T12:00:00',departureAt:'2026-09-15T12:00:00',consignor:party,consignee:party,...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),containers:[{containerId:ktk,empty:true,ownerClientId:owner}]},201);}
async function confirm(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-09-15T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});return r.route.id;}
const finish=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'},status);
async function arrival(ktk,owner=a,completed=true){ktk=ktk||await generated();const r=await transport('receiving',ktk,owner);await confirm('receiving',r.id);if(completed)await finish('receiving',r.id);return {ktk,receiving:r.id};}
async function ship(ktk,completed=true){const r=await transport('shipping',ktk);await confirm('shipping',r.id);if(completed)await finish('shipping',r.id);return r.id;}
async function transfer(ktk,next,date){const id=(await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',effectiveDate:date,containerOwnerIds:[sql(`select id from container_owner where container_id='${ktk}'`)]},201)).order.id;await api('/service-orders/'+id+'/accept','POST');return id;}
const report=ktk=>api('/container-storage-periods?size=100&query='+sql(`select code from container where id='${ktk}'`));
const cancel=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus:sql(`select order_status from ${kind}_order where id='${id}'`)},status);
return {a,b,c,generated,transport,confirm,finish,arrival,ship,transfer,report,cancel};}
async function capture(){const r={};for(const p of ['/container-storage-periods?size=100','/container-storage-periods?size=100&status=ALL','/container-storage-periods/export','/container-storage-periods/export?status=CLOSED']){const a=await fetch(base+p);assert.equal(a.status,200);r[p]=await a.text();}return r;}
const count=(table,k)=>Number(sql(`select count(*) from ${table} where container_id='${k}'`));
const owner=k=>sql(`select client_id from container_owner_current where container_id='${k}'`);
async function seed(){const x=await init('billing-actual-receiving-old');assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'58');
await clock('2026-09-15');const closed=await x.arrival();await clock('2026-09-17');await x.transfer(closed.ktk,x.b,'2026-09-17');await clock('2026-09-20');closed.shipping=await x.ship(closed.ktk);
const pending=await x.arrival(undefined,x.b,false);const cancelled=await x.arrival(undefined,x.c,false);await x.cancel('receiving',cancelled.receiving);
const repeat=await x.arrival();repeat.shipping=await x.ship(repeat.ktk);repeat.pending=await x.arrival(repeat.ktk,x.b,false);
const open=await x.arrival();open.future=await x.transfer(open.ktk,x.b,'2026-09-25');open.shipping=await x.ship(open.ktk,false);
fs.writeFileSync('actual-fixture.json',JSON.stringify({closed,pending,cancelled,repeat,open}));fs.writeFileSync('actual-before-api.json',JSON.stringify(await capture()));
fs.writeFileSync('actual-before-history.json',sql('select json_agg(h order by id) from container_owner_history h'));
fs.writeFileSync('actual-before-visits.json',sql('select json_agg(v order by id) from container_visit v where receiving_date is not null'));
run(['exec',pg,'pg_dump','-U','billing','-d',db,'-Fc','-f','/tmp/seeded-v58.dump']);console.log('PASS: V58 fixtures prepared (closed report A2/B4, pending/cancelled receiving, repeat reservation, future transfer and reserved shipping)');}
async function check(){const x=await init('billing-actual-receiving-new');assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'59');const f=JSON.parse(fs.readFileSync('actual-fixture.json'));
assert.deepEqual(await capture(),JSON.parse(fs.readFileSync('actual-before-api.json')));assert.deepEqual(json('select json_agg(h order by id) from container_owner_history h'),JSON.parse(fs.readFileSync('actual-before-history.json')));assert.deepEqual(json('select json_agg(v order by id) from container_visit v where receiving_date is not null'),JSON.parse(fs.readFileSync('actual-before-visits.json')));
assert.equal(sql('select count(*) from container_visit where receiving_date is null'),'0');assert.equal(count('container_visit',f.pending.ktk),0);assert.equal(count('container_ownership_period',f.pending.ktk),0);assert.equal(owner(f.pending.ktk),x.b);
await x.finish('receiving',f.pending.receiving);assert.equal(count('container_visit',f.pending.ktk),1);assert.equal(count('container_ownership_period',f.pending.ktk),1);
await x.cancel('receiving',f.repeat.pending.receiving);assert.equal(owner(f.repeat.ktk),x.a);assert.equal(sql(`select container_visit_id from container_owner where container_id='${f.repeat.ktk}'`),sql(`select id from container_visit where receiving_order_id='${f.repeat.receiving}'`));
assert.deepEqual((await x.report(f.closed.ktk)).items.map(r=>r.storageDays).sort(),[2,4]);console.log('PASS: migration preserves report/CSV, physical rows and all audit events; prior pending receipt completes, prior repeated reservation cancels correctly');

await clock('2026-10-01');const k=await x.generated(),draft=await x.transport('receiving',k);assert.equal(count('container_visit',k),0);assert.equal(count('container_ownership_period',k),0);
await x.confirm('receiving',draft.id);assert.equal(count('container_visit',k),0);assert.equal(count('container_ownership_period',k),0);assert.equal(sql(`select receiving_order_id from container_owner where container_id='${k}'`),draft.id);
await x.cancel('receiving',draft.id);assert.equal(count('container_visit',k),0);assert.equal(count('container_ownership_period',k),0);assert.equal(owner(k),x.a);
const r=await x.arrival(k,x.b,false);await clock('2026-10-03');await x.finish('receiving',r.receiving);assert.equal(count('container_visit',k),1);assert.equal(count('container_ownership_period',k),1);assert.equal(sql(`select receiving_date from container_visit where container_id='${k}'`),'2026-10-03');assert.equal(owner(k),x.b);
const originalVisit=sql(`select id from container_visit where container_id='${k}'`);await x.transfer(k,x.c,'2026-10-03');assert.deepEqual((await x.report(k)).items.map(r=>r.storageDays).sort(),[0,1]);
await x.transfer(k,x.a,'2026-10-07');assert.equal(owner(k),x.c);assert.equal((await x.report(k)).items.length,2);
await clock('2026-10-07');assert.equal(owner(k),x.a);await clock('2026-10-05');assert.equal(owner(k),x.c);
const sh=await x.ship(k,false),assignments=count('container_ownership_period',k);assert.equal(sql(`select shipping_date from container_visit where id='${originalVisit}'`),'');
await x.cancel('shipping',sh);assert.equal(count('container_ownership_period',k),assignments);assert.equal(owner(k),x.c);
const sh2=await x.ship(k);assert.equal(sql(`select shipping_date from container_visit where id='${originalVisit}'`),'2026-10-05');assert.equal(count('container_visit',k),1);assert.equal(count('container_ownership_period',k),assignments);assert.equal(sql(`select count(*) from container_ownership_period where container_id='${k}' and is_withdrawn`),'1');
await x.cancel('shipping',sh2);assert.equal(sql(`select shipping_date from container_visit where id='${originalVisit}'`),'');assert.equal(owner(k),x.c);assert.equal(count('container_ownership_period',k),assignments);
await x.cancel('receiving',r.receiving);assert.equal(count('container_ownership_period',k),assignments);assert.equal((await x.report(k)).items.length,0);
await clock('2026-10-08');const repeat=await x.arrival(k,x.a,false);assert.equal(count('container_visit',k),1);assert.equal(count('container_ownership_period',k),assignments);
await x.finish('receiving',repeat.receiving);assert.equal(count('container_visit',k),2);assert.equal(count('container_ownership_period',k),assignments+1);assert.notEqual(sql(`select container_visit_id from container_owner where container_id='${k}'`),originalVisit);assert.equal(owner(k),x.a);
console.log('PASS: no rows on draft/confirmation/cancelled expectation; actual receiving date; same-day/future transfers; calendar forward/back; shipping updates visit only; shipping/receiving cancellations and repeated receiving');

// Rail receiving: no visit at confirmation; cancellation releases the bill for reuse.
const service=(await api('/comprehensive-service-orders/available-services'))[0];const tariff=json(`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='${service.id}' and active order by id limit 1)t`);
const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);const req={complexServiceId:service.id,clientId:tariff.client_id,contractId:tariff.contract_id,defaultContainerOwnerId:x.a,waybillIds:[bill.id]};
async function section(root,action){return api('/comprehensive-service-orders/'+root+'/'+(action==='PREPARE_TRANSPORT'?'prepare-transport':'complete-section'),'POST',{section:'INITIAL_RECEIVING',...(action==='PREPARE_TRANSPORT'?{}:{action})});}
let rail=await api('/comprehensive-service-orders','POST',req,201);const railK=rail.receivingOrder.containers[0].containerId;
await section(rail.order.id,'PREPARE_TRANSPORT');await section(rail.order.id,'CONFIRM_ROUTES');assert.equal(count('container_visit',railK),0);assert.equal(count('container_ownership_period',railK),0);
for(const shipping of rail.shippingOrders)await x.cancel('shipping',shipping.id);await x.cancel('receiving',rail.receivingOrder.id);assert.equal(count('container_visit',railK),0);
rail=await api('/comprehensive-service-orders','POST',{...req,defaultContainerOwnerId:x.b},201);await section(rail.order.id,'PREPARE_TRANSPORT');await section(rail.order.id,'CONFIRM_ROUTES');await section(rail.order.id,'COMPLETE_ORDERS');assert.equal(count('container_visit',railK),1);assert.equal(count('container_ownership_period',railK),1);assert.equal(owner(railK),x.b);assert.equal(sql(`select count(*) from container_visit where container_id='${railK}' and waybill_container_id is not null`),'1');
console.log('PASS: railway confirmation has no physical visit, cancellation/reused waybill, actual rail receipt with one ownership assignment');

const race=await x.arrival(undefined,x.a,false);const responses=await Promise.all([1,2].map(()=>fetch(base+'/receiving-orders/'+race.receiving+'/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventCode:'UNLOAD_FINISH'})})));assert.ok(responses.some(r=>r.status===200));assert.ok(responses.every(r=>[200,409].includes(r.status)));assert.equal(count('container_visit',race.ktk),1);assert.equal(count('container_ownership_period',race.ktk),1);
const duplicate=await x.generated(),d1=await x.transport('receiving',duplicate),d2=await x.transport('receiving',duplicate);const results=await Promise.allSettled([x.confirm('receiving',d1.id),x.confirm('receiving',d2.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(count('container_visit',duplicate),0);assert.equal(count('container_ownership_period',duplicate),0);
sql('do $$ declare v record;begin for v in select id from container_visit loop perform check_container_visit(v.id);end loop;end $$;');
fs.writeFileSync('actual-after-api.json',JSON.stringify(await capture()));console.log('PASS: simultaneous receipt completion is single, competing confirmations reserve once, all visits reconcile');}
(process.argv[2]==='seed'?seed:check)().catch(e=>{console.error(e);process.exitCode=1});
