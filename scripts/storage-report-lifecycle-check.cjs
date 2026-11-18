// Writes fixtures ONLY in billing_storage_report_test AFTER the read-only before/after benchmark.
// Leaves test documents there and restores the original calendar. Never run on billing_next.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_storage_report_test',base='http://127.0.0.1:8213/api';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
const sql=q=>run(['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const json=q=>JSON.parse(sql(q));
assert.equal(sql('select current_database()'),db);
const info=JSON.parse(run(['inspect','billing-next-storage-report-test']))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));
assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8213'));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
const finish=(kind,id)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});
const cancel=(kind,id)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'Проверка компактного отчёта на отдельной БД'});
(async()=>{
 const saved=await api('/application-clock');
 try{
 await clock('2026-09-15');
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const clients=await api('/references/clients'),owner=tariff.client_id,others=clients.filter(c=>c.id!==owner).slice(0,2),party=clients.find(c=>c.id===owner).name;
 assert.equal(others.length,2);
 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);
 const c=sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}'`);
 const code=sql(`select code from container where id='${c}'`);
 async function manual(kind,rail=false){return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,
  transportType:rail?'RAILWAY':'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),
  arrivalAt:'2026-12-01T12:00:00',departureAt:'2026-12-01T12:00:00',consignor:party,consignee:party,
  ...(rail?{waybillIds:[bill.id]}:{containers:[{containerId:c,empty:true,ownerClientId:owner}]})},201);}
 async function confirm(kind,id,rail=false){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:rail?'RAILWAY':'VEHICLE',
  terminalAreaId:area,departureAt:'2026-12-01T12:00:00+03:00',...(rail?{}:logistics),orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});}
 async function change(next){const id=sql(`select id from container_owner where container_id='${c}'`);const o=await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',containerOwnerIds:[id]},201);await api('/service-orders/'+o.order.id+'/accept','POST');return o.order.id;}
 async function report(){const rows=(await api('/container-storage-periods?size=100&query='+code)).items;
  const expected=json(`select coalesce(json_agg(t order by t."arrivalAt" desc,t.id),'[]') from (select id,container_id "containerId",container_name "containerName",owner_name "ownerName",receiving_at "arrivalAt",shipping_at "departureAt",status,start_order_id "startOrderId",start_order_type "startOrderType",start_order_number "startOrderNumber",end_order_id "endOrderId",end_order_type "endOrderType",end_order_number "endOrderNumber" from container_storage_period_view where container_id='${c}')t`);
  const normalize=r=>{const copy={...r};delete copy.storageDays;return {...copy,arrivalAt:new Date(r.arrivalAt).toISOString(),departureAt:r.departureAt?new Date(r.departureAt).toISOString():null,endOrderId:r.endOrderId??null,endOrderType:r.endOrderType??null,endOrderNumber:r.endOrderNumber??null};};
  assert.deepEqual(rows.map(normalize),expected.map(normalize));return rows;
 }
 const r=await manual('receiving');await confirm('receiving',r.id);assert.equal((await report()).length,0);
 await finish('receiving',r.id);let rows=await report();assert.equal(rows.length,1);assert.equal(rows[0].startOrderId,r.id);
 assert.equal(rows[0].storageDays,1);
 const first=rows[0].id;await clock('2026-09-17');const ch1=await change(others[0].id),ch2=await change(others[1].id);
 rows=await report();assert.equal(rows.length,3);assert.equal(rows.find(p=>p.id===first).endOrderId,ch1);
 const open=rows.find(p=>p.status==='OPEN');assert.equal(open.startOrderId,ch2);assert.equal(open.ownerName,others[1].name);
 assert.equal(rows.find(p=>p.id===first).storageDays,2);assert.equal(rows.find(p=>p.startOrderId===ch1).storageDays,0);assert.equal(open.storageDays,1);
 await clock('2026-09-20');assert.equal((await report()).find(p=>p.id===open.id).storageDays,4);
 const shipping=await manual('shipping');await confirm('shipping',shipping.id);await finish('shipping',shipping.id);
 rows=await report();assert.equal(rows.find(p=>p.id===open.id).endOrderId,shipping.id);assert.ok(rows.every(p=>p.status==='CLOSED'));
 assert.equal(rows.find(p=>p.id===open.id).storageDays,4);
 await clock('2026-09-21');assert.equal((await report()).find(p=>p.id===open.id).storageDays,4);
 await cancel('shipping',shipping.id);rows=await report();assert.equal(rows.find(p=>p.id===open.id).status,'OPEN');assert.equal(rows.find(p=>p.id===open.id).endOrderId??null,null);
 assert.equal(rows.find(p=>p.id===open.id).storageDays,5);
 assert.equal((await api('/container-storage-periods?periodId='+open.id+'&asOf=2026-09-18')).items[0].storageDays,2);
 await cancel('receiving',r.id);assert.equal((await report()).length,0);
 assert.equal((await api('/container-storage-periods?status=ALL&periodId='+first)).totalElements,0);
 const rail=await manual('receiving',true);await confirm('receiving',rail.id,true);await finish('receiving',rail.id);
 const railPeriod=(await report())[0];assert.equal(railPeriod.startOrderId,rail.id);
 const departure=await manual('shipping');await confirm('shipping',departure.id);await finish('shipping',departure.id);
 const repeat=await manual('receiving');await confirm('receiving',repeat.id);await finish('receiving',repeat.id);
 rows=await report();assert.equal(rows.length,2);assert.equal(rows.find(p=>p.status==='OPEN').startOrderId,repeat.id);assert.equal(rows.find(p=>p.id===railPeriod.id).endOrderId,departure.id);
 await cancel('receiving',repeat.id);await cancel('shipping',departure.id);await cancel('receiving',rail.id);assert.equal((await report()).length,0);
 console.log('PASS: auto/rail arrivals, same-day owner changes, owner-change to departure, cancellation/reopening, cancelled chain exclusion, repeated visits; rows match the original VIEW');
 }finally{await clock(saved.mode==='SYSTEM'?null:saved.date);}
})().catch(e=>{console.error(e);process.exitCode=1});
