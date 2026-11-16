// Mutating integration checks. Refuses any database/backend other than this isolated fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_storage_test',base='http://127.0.0.1:8196/api';
const inspect=JSON.parse(execFileSync(docker,['inspect','billing-next-storage-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(inspect.Config.Env.includes('DB_NAME='+db));
assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8196'));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();
assert.equal(sql('select current_database()'),db);
const json=q=>JSON.parse(sql(q));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();let v;try{v=JSON.parse(t)}catch{v=t}assert.equal(r.status,status,p+': '+t);return v}
const cancel=(kind,id,expectedStatus,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus,reason:'Проверка истории хранения'},status);
const finish=(kind,id)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});
const periods=c=>json(`select coalesce(json_agg(p order by created_at,id),'[]') from container_storage_period p where container_id='${c}'`);
const history=c=>api('/containers/'+c+'/owner-history?includeReservations=true');
(async()=>{
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const owner=tariff.client_id,party=(await api('/references/clients')).find(p=>p.id===owner).name;
 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);
 const c=sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}' limit 1`);
 async function manual(kind){return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,
   transportType:'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),arrivalAt:'2026-11-01T12:00:00',
   departureAt:'2026-11-01T12:00:00',consignor:party,consignee:party,containers:[{containerId:c,empty:true,ownerClientId:owner}]},201)}
 async function confirm(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',
   terminalAreaId:area,departureAt:'2026-11-01T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});}
 let r=await manual('receiving');await confirm('receiving',r.id);assert.equal(periods(c).length,0);
 await cancel('receiving',r.id,'CONFIRMED');assert.equal(periods(c).length,0);
 assert.ok((await history(c)).some(h=>h.operationType==='CANCEL_RECEIVING_RESERVATION'&&h.targetHistoryId&&!h.storagePeriodId));
 r=await manual('receiving');await confirm('receiving',r.id);await finish('receiving',r.id);
 let p=periods(c)[0];assert.equal(p.status,'OPEN');assert.equal(p.is_empty,true);assert.equal(p.receiving_order_id,r.id);
 const hid=p.receiving_history_id,pid=p.id,arrival=p.receiving_at;
 let h=(await history(c)).find(h=>h.id===hid);assert.equal(h.storagePeriodId,pid);assert.equal(h.operationType,'ARRIVAL');
 assert.equal(h.timeSource,'MANUAL_COMPLETION');assert.ok(h.occurredAt);
 await finish('receiving',r.id);assert.equal(periods(c).length,1);assert.equal((await history(c)).filter(h=>h.operationType==='ARRIVAL').length,1);
 let s=await manual('shipping');await confirm('shipping',s.id);assert.deepEqual(periods(c)[0],p);
 await cancel('shipping',s.id,'CONFIRMED');assert.deepEqual(periods(c)[0],p);
 assert.ok((await history(c)).some(h=>h.operationType==='CANCEL_SHIPPING_RESERVATION'&&h.storagePeriodId===pid&&h.targetHistoryId));
 console.log('PASS: reservations never start/stop storage; arrival links and repeated completion');
 s=await manual('shipping');await confirm('shipping',s.id);await finish('shipping',s.id);p=periods(c)[0];
 assert.equal(p.status,'CLOSED');assert.equal(p.shipping_order_id,s.id);assert.ok(p.shipping_history_id);const dh=p.shipping_history_id;
 await Promise.all([finish('shipping',s.id),finish('shipping',s.id)]);assert.deepEqual(periods(c)[0],p);
 let report=await api('/container-storage-periods?periodId='+pid);assert.equal(report.items[0].storageDays,1);assert.equal(report.items[0].inStock,false);
 await Promise.all([cancel('shipping',s.id,'COMPLETED'),cancel('shipping',s.id,'COMPLETED')]);p=periods(c)[0];
 assert.equal(p.id,pid);assert.equal(p.receiving_at,arrival);assert.equal(p.status,'OPEN');assert.equal(p.shipping_at,null);
 assert.equal(p.shipping_order_id,null);assert.equal(p.shipping_history_id,null);assert.equal(p.version,2);
 h=(await history(c)).filter(h=>h.operationType==='CANCEL_DEPARTURE');assert.equal(h.length,1);assert.equal(h[0].targetHistoryId,dh);
 assert.equal(h[0].storagePeriodId,pid);assert.equal(h[0].reason,'Проверка истории хранения');
 assert.ok((await history(c)).find(h=>h.id===dh&&!h.cancellation));
 console.log('PASS: departure/reopening, immutable original history, cancellation reason, concurrent retries');
 // Test-only date fixture: calendar boundaries use Moscow, not elapsed 24-hour blocks.
 sql(`update container_storage_period set receiving_at='2026-10-31T21:30:00Z' where id='${pid}'; update container_owner_history set occurred_at='2026-10-31T21:30:00Z' where id='${hid}'`);
 report=await api('/container-storage-periods?periodId='+pid+'&asOf=2026-11-05');assert.equal(report.items[0].storageDays,5);
 report=await api('/container-storage-periods?periodId='+pid+'&asOf=2026-10-31');assert.equal(report.totalElements,0);
 s=await manual('shipping');await confirm('shipping',s.id);await finish('shipping',s.id);p=periods(c)[0];
 const r2=await manual('receiving');await confirm('receiving',r2.id);await cancel('shipping',s.id,'COMPLETED',409);assert.deepEqual(periods(c)[0],p);
 await finish('receiving',r2.id);assert.equal(periods(c).length,2);assert.notEqual(periods(c)[1].id,pid);
 await cancel('shipping',s.id,'COMPLETED',409);await cancel('receiving',r2.id,'COMPLETED');
 assert.equal(periods(c)[1].status,'CANCELLED');assert.ok(periods(c)[1].receiving_at);
 await cancel('shipping',s.id,'COMPLETED');assert.equal(periods(c)[0].status,'OPEN');
 await cancel('receiving',r.id,'COMPLETED');assert.equal(periods(c)[0].status,'CANCELLED');
 report=await api('/container-storage-periods?periodId='+pid+'&status=ALL');assert.equal(report.items[0].storageDays,undefined);
 assert.equal((await api('/container-storage-periods?periodId='+pid)).totalElements,0);
 console.log('PASS: Moscow inclusive days, repeated visits, dependency guards, reverse chain, annulled periods excluded');
 await api('/container-storage-periods?status=unknown','GET',undefined,400);
 await api('/container-storage-periods?arrivalFrom=2026-11-10&arrivalTo=2026-11-01','GET',undefined,400);
 const csv=await fetch(base+'/container-storage-periods/export?periodId='+pid+'&status=ALL');assert.equal(csv.status,200);
 assert.match(csv.headers.get('content-type'),/text\/csv/);const bytes=new Uint8Array(await csv.arrayBuffer());assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
 const csvText=new TextDecoder().decode(bytes);assert.match(csvText,/Аннулирован/);assert.equal(csvText.trim().split('\r\n').length,2);
 // All linked facts must refer to the same physical container and period.
 assert.equal(sql(`select count(*) from container_owner_history h join container_storage_period p on p.id=h.storage_period_id where h.container_id<>p.container_id`),'0');
 assert.equal(sql(`select count(*) from container_storage_period p join container_owner_history h on h.id=p.receiving_history_id where h.storage_period_id<>p.id`),'0');
 assert.equal(sql(`select count(*) from container_storage_period where status='OPEN' and not needs_review and shipping_at is not null`),'0');
 fs.mkdirSync(path.join(__dirname,'../backups'),{recursive:true});
 fs.writeFileSync(path.join(__dirname,'../backups/storage-fixtures.json'),JSON.stringify({db,containerId:c,periodId:pid}));
 console.log('PASS: filter validation, CSV export, bidirectional history consistency');
})().catch(e=>{console.error(e);process.exitCode=1});
