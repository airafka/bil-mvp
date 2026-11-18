// Mutating acceptance checks: only the dedicated PostgreSQL/container and port below.
const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',pg='billing-owner-schedule-db-test',db='billing_owner_schedule_test',backend='billing-owner-schedule-backend-test',base='http://127.0.0.1:8224/api';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
const sql=q=>run(['exec',pg,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const json=q=>JSON.parse(sql(q)),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
async function waitDone(id){for(let n=0;n<30;n++){if(sql(`select status from service_order where id='${id}'`)==='DONE')return;await pause(500);}throw Error('Scheduler did not finish '+id);}
const history=id=>json(`select coalesce(json_agg(t order by created_at),'[]') from (select * from container_owner_history where order_id='${id}')t`);
const owner=c=>sql(`select client_id from container_owner where container_id='${c}'`);
const finish=(kind,id)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});
(async()=>{
 assert.equal(sql('select current_database()'),db);assert.equal(sql('select max(version::int) from flyway_schema_history'),'54');
 const inspect=JSON.parse(run(['inspect',backend]))[0];assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.Config.Env.includes('DB_HOST='+pg));assert.equal(inspect.NetworkSettings.Ports['8080/tcp'][0].HostPort,'8224');
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const clients=await api('/references/clients'),a=tariff.client_id,[b,c]=clients.filter(x=>x.id!==a).slice(0,2).map(x=>x.id),party=clients.find(x=>x.id===a).name;
 const area=(await api('/references/terminal-areas')).find(x=>x.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 async function generated(){const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);return sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}' limit 1`);}
 async function transport(kind,ktk,receivingOwner=a){return api('/'+kind+'-orders','POST',{clientId:a,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',arrivalAt:'2026-09-15T12:00:00',departureAt:'2026-09-15T12:00:00',consignor:party,consignee:party,...(kind==='receiving'?{defaultContainerOwnerId:receivingOwner}:{}),containers:[{containerId:ktk,empty:true,ownerClientId:receivingOwner}]},201);}
 async function confirm(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-09-15T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});return r.route.id;}
 async function arrival(){const ktk=await generated(),r=await transport('receiving',ktk);await confirm('receiving',r.id);await finish('receiving',r.id);return {ktk,receiving:r.id};}
 async function create(ktks,next,date){return (await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',effectiveDate:date,containerOwnerIds:ktks.map(k=>sql(`select id from container_owner where container_id='${k}'`))},201)).order.id;}
 async function schedule(ktks,next,date){const id=await create(ktks,next,date);assert.equal((await api('/service-orders/'+id+'/accept','POST')).order.status,'SCHEDULED');return id;}
 const report=ktk=>api('/container-storage-periods?size=100&query='+sql(`select code from container where id='${ktk}'`));

 await clock('2026-09-15');const first=await arrival();const id=await schedule([first.ktk],b,'2026-09-17');
 assert.equal(owner(first.ktk),a);assert.deepEqual(history(id),[]);assert.equal((await report(first.ktk)).items.length,1);
 await api('/service-orders/'+id,'PUT',{id,service:'CHANGE_OWNER',effectiveDate:'2026-09-18'},409);
 await api('/service-orders/'+id,'DELETE',undefined,409);await api('/service-orders/'+id+'/accept','POST',undefined,409);
 await api('/service-orders','POST',{clientId:c,service:'CHANGE_OWNER',effectiveDate:'2026-09-18',containerOwnerIds:[sql(`select id from container_owner where container_id='${first.ktk}'`)]},409);
 await clock('2026-09-16');await pause(1600);assert.deepEqual(history(id),[]);
 console.log('PASS future date, no early history/period, immutable waiting order, one active order per KTK');

 await clock('2026-09-17');await waitDone(id);assert.equal(owner(first.ktk),b);assert.equal(history(id).length,1);
 assert.equal(sql(`select occurred_at at time zone 'Europe/Moscow' from container_owner_history where order_id='${id}'`),'2026-09-17 00:00:00');
 let rows=(await report(first.ktk)).items;assert.equal(rows.length,2);assert.equal(rows.find(x=>x.status==='CLOSED').storageDays,2);assert.equal(rows.find(x=>x.status==='OPEN').storageDays,1);
 await clock('2026-09-16');await pause(1500);assert.equal(owner(first.ktk),b);assert.equal(history(id).length,1);
 const backdated=await create([first.ktk],c,'2026-09-16');await api('/service-orders/'+backdated+'/accept','POST',undefined,409);assert.deepEqual(history(backdated),[]);await api('/service-orders/'+backdated,'DELETE',undefined,204);
 console.log('PASS autonomous scheduler (no API reads), Moscow boundary, storage days and no reversal on clock rollback');

 await clock('2026-09-18');const same=await schedule([first.ktk],c,'2026-09-18');await waitDone(same);
 assert.equal(history(same).length,1);assert.equal(sql(`select (occurred_at at time zone 'Europe/Moscow')::date from container_owner_history where order_id='${same}'`),'2026-09-18');
 const undo=await schedule([first.ktk],a,'2026-09-21');assert.equal((await api('/service-orders/'+undo+'/withdraw','POST')).order.status,'DRAFT');
 await api('/service-orders/'+undo,'PUT',{id:undo,service:'CHANGE_OWNER',effectiveDate:'2026-09-17'});await api('/service-orders/'+undo+'/accept','POST',undefined,400);
 await api('/service-orders/'+undo,'DELETE',undefined,204);
 console.log('PASS same-day transfer, withdrawal/edit/delete and rejection of past confirmation');

 const missed=await schedule([first.ktk],a,'2026-09-19');run(['stop',backend]);
 sql("update application_clock set business_date='2026-09-22',version=version+1 where id=1");run(['start',backend]);
 await waitDone(missed);assert.equal(sql(`select (occurred_at at time zone 'Europe/Moscow')::date from container_owner_history where order_id='${missed}'`),'2026-09-19');
 rows=(await report(first.ktk)).items;assert.equal(rows.find(x=>x.status==='OPEN').storageDays,4);
 console.log('PASS restart with overdue transfer preserves effective date and storage days');

 // The second worker and HTTP catch-up compete for the same order; one history event is committed.
 const secondName='billing-owner-schedule-worker-test';assert.ok(!run(['ps','-a','--format','{{.Names}}']).split('\n').includes(secondName));
 run(['run','-d','--name',secondName,'--network','billing-owner-schedule-test','--label','billing.task=owner-schedule','-e','DB_HOST='+pg,'-e','DB_NAME='+db,'-e','DB_USER=billing','-e','DB_PASSWORD=billing','-e','APP_OWNERSHIP_SCHEDULER_DELAY_MS=500','billing-owner-schedule-backend-test']);
 const race=await schedule([first.ktk],b,'2026-09-23');await clock('2026-09-23');
 await Promise.all(Array.from({length:8},()=>api('/service-orders/'+race)));await waitDone(race);await pause(6000);assert.equal(history(race).length,1);run(['stop',secondName]);run(['rm',secondName]);
 console.log('PASS two backend workers plus concurrent HTTP requests execute once');

 // Simulate a normal ownership-changing receipt before the scheduled date, using only business APIs.
 const ship=await transport('shipping',first.ktk);await confirm('shipping',ship.id);await finish('shipping',ship.id);
 const current=await schedule([first.ktk],c,'2026-09-26');await clock('2026-09-24');
 const receipt=await transport('receiving',first.ktk,a);await confirm('receiving',receipt.id);await finish('receiving',receipt.id);
 assert.equal(owner(first.ktk),a);await clock('2026-09-26');await waitDone(current);assert.equal(history(current)[0].old_client_id,a);assert.equal(owner(first.ktk),c);
 console.log('PASS execution reads actual current owner, with no owner/history snapshot fields');

 await clock('2026-09-27');const second=await arrival();const batch=await schedule([first.ktk,second.ktk],b,'2026-09-28');
 // Test-only corruption is inside the isolated database: one target already belongs to B.
 sql(`update container_owner set client_id='${b}' where container_id='${second.ktk}'`);
 await clock('2026-09-28');await pause(2000);assert.equal(sql(`select status from service_order where id='${batch}'`),'SCHEDULED');assert.deepEqual(history(batch),[]);assert.equal(owner(first.ktk),c);
 await api('/container-storage-periods', 'GET',undefined,409);
 await api('/service-orders/'+batch+'/withdraw','POST');sql(`update container_owner set client_id='${a}' where container_id='${second.ktk}'`);await api('/service-orders/'+batch,'DELETE',undefined,204);
 console.log('PASS whole-order rollback on one invalid KTK, stale report blocked, failed order recoverable');

 const last=await schedule([first.ktk],a,'2026-09-30');await clock('2026-10-01');await api('/container-storage-periods');await waitDone(last);assert.equal(history(last).length,1);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and column_name in ('expected_owner_id','confirmed_history_id')"),'0');
 const evidence={container:first.ktk,order:last,client:b,date:'2026-10-02',base};
 if(process.env.OWNERSHIP_UI_FIXTURE)fs.writeFileSync(process.env.OWNERSHIP_UI_FIXTURE,JSON.stringify(evidence));
 console.log('PASS request catch-up, no prohibited fields; all ownership scheduling acceptance checks passed');
})().catch(e=>{console.error(e.message);process.exitCode=1});
