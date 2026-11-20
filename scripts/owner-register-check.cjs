const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',pg='billing-register-owner-db',db='billing_register_owner_test',base='http://127.0.0.1:8355/api';
const run=(a,input)=>execFileSync(docker,a,{input,encoding:'utf8',windowsHide:true,maxBuffer:80*1024*1024}).trim();
const sql=q=>run(['exec','-i',pg,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q),json=q=>JSON.parse(sql(q));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
async function init(name){const i=JSON.parse(run(['inspect',name]))[0];assert.ok(i.Config.Env.includes('DB_NAME='+db));assert.ok(i.Config.Env.includes('DB_HOST=db'));assert.deepEqual(Object.keys(i.NetworkSettings.Networks),['billing-register-owner']);assert.equal(i.Config.Labels['billing.task'],'register-owner');assert.ok(i.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8355'));assert.equal(sql('select current_database()'),db);
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

// Only the explicitly named isolated stack is accepted by init().
const physical=k=>sql(`select client_id from container_owner where container_id='${k}'`);
const stable=()=>json("select json_build_object('visits',(select json_agg(t order by id) from container_visit t),'periods',(select json_agg(t order by id) from container_ownership_period t),'history',(select json_agg(t order by id) from container_owner_history t))");
async function expectOwner(k,id){await api('/container-owners?size=100');assert.equal(owner(k),id);assert.equal(physical(k),id);}
async function seed(){const x=await init('billing-register-owner-old');assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'59');
await clock('2026-09-15');const closed=await x.arrival();await clock('2026-09-17');await x.transfer(closed.ktk,x.b,'2026-09-17');await clock('2026-09-20');closed.shipping=await x.ship(closed.ktk);
const pending=await x.arrival(undefined,x.b,false),cancelled=await x.arrival(undefined,x.c,false);await x.cancel('receiving',cancelled.receiving);
const repeat=await x.arrival();repeat.shipping=await x.ship(repeat.ktk);repeat.pending=await x.arrival(repeat.ktk,x.b,false);
const open=await x.arrival();open.future=await x.transfer(open.ktk,x.b,'2026-09-25');open.shipping=await x.ship(open.ktk,false);
fs.writeFileSync('owner-fixture.json',JSON.stringify({closed,pending,cancelled,repeat,open}));fs.writeFileSync('owner-before-api.json',JSON.stringify(await capture()));fs.writeFileSync('owner-before-data.json',JSON.stringify(stable()));
console.log('PASS V59 fixtures: four statuses, repeated/cancelled receiving, A2/B4, future transfer');}
async function check(){const x=await init('billing-register-owner-new');assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'60');const f=JSON.parse(fs.readFileSync('owner-fixture.json'));
assert.deepEqual(await capture(),JSON.parse(fs.readFileSync('owner-before-api.json')));assert.deepEqual(stable(),JSON.parse(fs.readFileSync('owner-before-data.json')));assert.equal(sql('select count(*) from container_owner o join container_owner_effective e using(id) where o.client_id is distinct from e.client_id'),'0');
assert.deepEqual((await x.report(f.closed.ktk)).items.map(p=>p.storageDays).sort(),[2,4]);
console.log('PASS migration: all visits, ownership and history unchanged; report and CSV byte-identical');
await expectOwner(f.pending.ktk,x.b);assert.equal(count('container_visit',f.pending.ktk),0);assert.equal(count('container_ownership_period',f.pending.ktk),0);await x.cancel('receiving',f.pending.receiving);await expectOwner(f.pending.ktk,x.b);await expectOwner(f.cancelled.ktk,x.c);
await expectOwner(f.repeat.ktk,x.b);await x.cancel('receiving',f.repeat.pending.receiving);await expectOwner(f.repeat.ktk,x.a);assert.equal(count('container_visit',f.repeat.ktk),1);
const again=await x.arrival(f.repeat.ktk,x.c,false);await expectOwner(f.repeat.ktk,x.c);assert.equal(count('container_visit',f.repeat.ktk),1);await x.finish('receiving',again.receiving);assert.equal(count('container_visit',f.repeat.ktk),2);await x.cancel('receiving',again.receiving);await expectOwner(f.repeat.ktk,x.a);
console.log('PASS receiving: selected owner in EXPECTED; no premature visit; both cancellations restore owner; repeated visit isolated');
const draft=await x.transport('shipping',f.open.ktk,x.a),initial=stable();await expectOwner(f.open.ktk,x.a);await clock('2026-09-24');await expectOwner(f.open.ktk,x.a);await clock('2026-09-25');await expectOwner(f.open.ktk,x.b);
assert.equal(sql(`select owner_container_id from shipping_order_container where shipping_order_id='${draft.id}'`),x.b);assert.equal(sql(`select owner_container_id from shipping_order_container where shipping_order_id='${f.open.shipping}'`),x.a);
await clock('2026-09-24');await expectOwner(f.open.ktk,x.a);await clock('2026-09-27');await expectOwner(f.open.ktk,x.b);assert.deepEqual(stable(),initial);await x.cancel('shipping',f.open.shipping);await expectOwner(f.open.ktk,x.b);await x.cancel('shipping',draft.id);
console.log('PASS dated transfer: calendar forward/back; only draft shipping follows owner; confirmed shipping frozen; no new audit events');
// Insert a historical owner between two existing assignments; latest owner stays B.
const back=await x.arrival();await clock('2026-09-30');await x.transfer(back.ktk,x.b,'2026-09-29');await x.transfer(back.ktk,x.c,'2026-09-28');await expectOwner(back.ktk,x.b);const report=await x.report(back.ktk);assert.deepEqual(report.items.map(p=>p.storageDays).sort(),[1,1,2]);
await clock('2026-09-28');await expectOwner(back.ktk,x.c);await clock('2026-09-27');await expectOwner(back.ktk,x.a);await clock('2026-09-30');await expectOwner(back.ktk,x.b);
console.log('PASS backdated insertion: A27, C28, B29; owners and report recalculate on calendar changes');
const same=await x.arrival();await x.transfer(same.ktk,x.b,'2026-09-30');await expectOwner(same.ktk,x.b);await x.ship(same.ktk);await expectOwner(same.ktk,x.b);
const early=await x.arrival();const future=await x.transfer(early.ktk,x.b,'2026-10-05');await x.ship(early.ktk);await clock('2026-10-05');await expectOwner(early.ktk,x.a);assert.equal(sql(`select result_status from service_order_container where service_order_id='${future}'`),'SKIPPED');
const withdraw=await x.arrival();let next=await x.transfer(withdraw.ktk,x.b,'2026-10-07');await api('/service-orders/'+next+'/withdraw','POST');await clock('2026-10-08');await expectOwner(withdraw.ktk,x.a);
await api('/service-orders/'+next,'PUT',{id:next,service:'CHANGE_OWNER',effectiveDate:'2026-10-10'});await api('/service-orders/'+next+'/accept','POST');await clock('2026-10-10');await expectOwner(withdraw.ktk,x.b);
console.log('PASS same-day receiving/transfer/shipping; shipping revokes future; withdrawal and rescheduling');
// At-most-once confirmation under concurrent requests.
const race=await x.arrival();const id=(await api('/service-orders','POST',{clientId:x.b,service:'CHANGE_OWNER',effectiveDate:'2026-10-10',containerOwnerIds:[sql(`select id from container_owner where container_id='${race.ktk}'`)]},201)).order.id;
const statuses=await Promise.all([1,2].map(()=>fetch(base+'/service-orders/'+id+'/accept',{method:'POST'}).then(r=>r.status)));assert.deepEqual(statuses.sort(),[200,409]);await expectOwner(race.ktk,x.b);assert.equal(sql(`select count(*) from container_owner_history where order_id='${id}'`),'1');
const version=sql(`select version from container_owner where container_id='${race.ktk}'`),audit=stable();await Promise.all(Array.from({length:8},()=>api('/container-owners?size=100')));assert.equal(sql(`select version from container_owner where container_id='${race.ktk}'`),version);assert.deepEqual(stable(),audit);
console.log('PASS concurrent confirmation: exactly one operation; repeated reads do not write unchanged register/history');
// Stop only this test backend and simulate time passing; first API access catches up.
const restart=await x.arrival();await x.transfer(restart.ktk,x.b,'2026-10-12');const beforeRestart=stable();run(['stop','billing-register-owner-new']);sql("update application_clock set business_date='2026-10-12',version=version+1 where id=1");assert.equal(physical(restart.ktk),x.a);run(['start','billing-register-owner-new']);
for(let n=0;n<45;n++){try{if((await fetch('http://127.0.0.1:8355/actuator/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
await expectOwner(restart.ktk,x.b);assert.deepEqual(stable(),beforeRestart);
// System clock mode must refresh a stale stored snapshot on access, too.
await clock(null);const systemDate=(await api('/application-clock')).date;const yesterday=new Date(systemDate+'T12:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);await clock(yesterday.toISOString().slice(0,10));const sys=await x.arrival();await x.transfer(sys.ktk,x.b,systemDate);sql('update application_clock set business_date=null,version=version+1 where id=1');assert.equal(physical(sys.ktk),x.a);await expectOwner(sys.ktk,x.b);
console.log('PASS downtime/restart and system-date access: owner refreshed without scheduler or added history');
// Rail receiving: no visit at confirmation; cancellation releases the bill for reuse.
const service=(await api('/comprehensive-service-orders/available-services'))[0];const tariff=json(`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='${service.id}' and active order by id limit 1)t`);
const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);const req={complexServiceId:service.id,clientId:tariff.client_id,contractId:tariff.contract_id,defaultContainerOwnerId:x.a,waybillIds:[bill.id]};
async function section(root,action){return api('/comprehensive-service-orders/'+root+'/'+(action==='PREPARE_TRANSPORT'?'prepare-transport':'complete-section'),'POST',{section:'INITIAL_RECEIVING',...(action==='PREPARE_TRANSPORT'?{}:{action})});}
let rail=await api('/comprehensive-service-orders','POST',req,201);const railK=rail.receivingOrder.containers[0].containerId;
await section(rail.order.id,'PREPARE_TRANSPORT');await section(rail.order.id,'CONFIRM_ROUTES');assert.equal(count('container_visit',railK),0);assert.equal(count('container_ownership_period',railK),0);
for(const shipping of rail.shippingOrders)await x.cancel('shipping',shipping.id);await x.cancel('receiving',rail.receivingOrder.id);assert.equal(count('container_visit',railK),0);
rail=await api('/comprehensive-service-orders','POST',{...req,defaultContainerOwnerId:x.b},201);await section(rail.order.id,'PREPARE_TRANSPORT');await section(rail.order.id,'CONFIRM_ROUTES');await section(rail.order.id,'COMPLETE_ORDERS');assert.equal(count('container_visit',railK),1);assert.equal(count('container_ownership_period',railK),1);assert.equal(owner(railK),x.b);assert.equal(sql(`select count(*) from container_visit where container_id='${railK}' and waybill_container_id is not null`),'1');
console.log('PASS: railway confirmation has no physical visit, cancellation/reused waybill, actual rail receipt with one ownership assignment');

await expectOwner(railK,x.b);
const completed=await x.arrival();const sent=await x.ship(completed.ktk);const periodCount=count('container_ownership_period',completed.ktk);await x.cancel('shipping',sent);await expectOwner(completed.ktk,x.a);assert.equal(count('container_ownership_period',completed.ktk),periodCount);assert.equal(sql("select status from container_owner where container_id='"+completed.ktk+"'"),'ON_TERMINAL');
console.log('PASS actual shipping cancellation preserves owner and assignments');
console.log('ALL OWNER REGISTER CHECKS PASSED');}
(process.argv[2]==='seed'?seed():check()).catch(e=>{console.error(e);process.exit(1);});
