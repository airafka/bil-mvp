// Checks the 17-column report on a fresh isolated V53 copy; leaves fixtures for UI checks.
// Leaves test documents there and restores the original calendar. Never run on billing_next.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_storage_details_test',base='http://127.0.0.1:8214/api';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
const sql=q=>run(['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const json=q=>JSON.parse(sql(q));
assert.equal(sql('select current_database()'),db);
assert.equal(sql('select max(version::integer) from flyway_schema_history where success'),'53');
const info=JSON.parse(run(['inspect','billing-next-storage-details-test']))[0];assert.ok(info.Config.Env.includes('DB_NAME='+db));
assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8214'));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
const finish=(kind,id)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});
const cancel=(kind,id)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'Проверка реквизитов отчёта на отдельной БД'});

const headers=['Номер КТК','Собственник КТК','Дней хранения','Начало периода','Событие','Заявка','Конец периода','Событие','Заявка','Клиент/Собственник поставки','Транспорт поставки','Грузоперевозчик/грузоотправитель поставки','Груз поставки','Клиент/Собственник вывоза','Транспорт вывоза','Грузоперевозчик/грузополучатель вывоза','Груз вывоза'];
function parseCsv(s){const rows=[];let row=[],cell='',quoted=false;s=s.replace(/^\uFEFF/,'');for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===';'&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}assert.equal(quoted,false);return rows;}
const date=s=>s?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(s)).replace(',',''):'';
const label=s=>({RECEIVING_ORDER:'Поставка',SHIPPING_ORDER:'Вывоз',SERVICE_ORDER:'Смена собственника'}[s]||'');
const transport=s=>({VEHICLE:'Авто',RAILWAY:'ЖД'}[s]||'');
const pair=(c,o)=>!c&&!o?'':(c||'—')+' / '+(o||'—');
const safe=s=>s==null?'':/^[\s]*[=+@-]/.test(String(s))?"'"+s:String(s);
async function checkCsv(rows,code){
 const response=await fetch(base+'/container-storage-periods/export?query='+code);assert.equal(response.status,200);
 const bytes=new Uint8Array(await response.arrayBuffer());assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
 const parsed=parseCsv(new TextDecoder().decode(bytes));assert.deepEqual(parsed[0],headers);
 assert.deepEqual(parsed.slice(1),rows.map(r=>[r.containerName,r.ownerName,r.storageDays,date(r.arrivalAt),label(r.startOrderType),r.startOrderNumber,date(r.departureAt),label(r.endOrderType),r.endOrderNumber,pair(r.receivingClientName,r.receivingOwnerName),transport(r.arrivalTransport),r.arrivalParty,r.arrivalCargo,pair(r.shippingClientName,r.shippingOwnerName),transport(r.departureTransport),r.departureParty,r.departureCargo].map(safe)));
}

(async()=>{
 const saved=await api('/application-clock');
 try{
 await clock('2026-09-15');
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const clients=await api('/references/clients'),owner=tariff.client_id,others=clients.filter(c=>c.id!==owner).slice(0,2),party=clients.find(c=>c.id===owner).name;
 assert.equal(others.length,2);
 const shippingContract=json("select row_to_json(t) from (select client_id,id from contract where client_id<>'"+owner+"' order by id limit 1)t");
 const products=json('select json_agg(t) from (select id,code from etsng_code order by code limit 3)t');assert.equal(products.length,3);
 const incomingCargo=products.slice(0,2).map(p=>({etsngCodeId:p.id,weight:100}));
 const outgoingCargo=[{etsngCodeId:products[2].id,weight:200}];

 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);
 const c=sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}'`);
 const code=sql(`select code from container where id='${c}'`);
 async function manual(kind,rail=false){return api('/'+kind+'-orders','POST',{clientId:kind==='receiving'?owner:shippingContract.client_id,contractId:kind==='receiving'?tariff.contract_id:shippingContract.id,terminalAreaId:area,
  transportType:rail?'RAILWAY':'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:others[1].id}:{}),
  arrivalAt:'2026-12-01T12:00:00',departureAt:'2026-12-01T12:00:00',consignor:party,consignee:party,
  ...(rail?(kind==='receiving'?{waybillIds:[bill.id]}:{railwayCarriages:[{railwayCarriageId:sql('select id from railway_carriage order by id limit 1'),containers:[{containerId:c,empty:false,cargoItems:outgoingCargo}]}]}):{containers:[{containerId:c,empty:false,ownerClientId:others[1].id,cargoItems:kind==='receiving'?incomingCargo:outgoingCargo}]})},201);}
 async function confirm(kind,id,rail=false){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:rail?'RAILWAY':'VEHICLE',
  terminalAreaId:area,departureAt:'2026-12-01T12:00:00+03:00',...(rail?{}:logistics),orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});}
 async function change(next){const id=sql(`select id from container_owner where container_id='${c}'`);const o=await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',containerOwnerIds:[id]},201);await api('/service-orders/'+o.order.id+'/accept','POST');return o.order.id;}
 async function report(){const rows=(await api('/container-storage-periods?size=100&query='+code)).items;
  const expected=json(`select coalesce(json_agg(t order by t."arrivalAt" desc,t.id),'[]') from (select id,container_id "containerId",container_name "containerName",owner_name "ownerName",receiving_at "arrivalAt",shipping_at "departureAt",status,start_order_id "startOrderId",start_order_type "startOrderType",start_order_number "startOrderNumber",end_order_id "endOrderId",end_order_type "endOrderType",end_order_number "endOrderNumber" from container_storage_period_view where container_id='${c}')t`);
  const normalize=r=>{const copy=Object.fromEntries(Object.keys(expected[0]||{}).map(k=>[k,r[k]]));return {...copy,arrivalAt:new Date(r.arrivalAt).toISOString(),departureAt:r.departureAt?new Date(r.departureAt).toISOString():null,endOrderId:r.endOrderId??null,endOrderType:r.endOrderType??null,endOrderNumber:r.endOrderNumber??null};};
  assert.deepEqual(rows.map(normalize),expected.map(normalize));
  for(const row of rows){
   const source=json("select row_to_json(t) from (select v.client_name,v.arrival_transport,v.arrival_carrier,v.consignor,v.cargo_name,v.shipping_client_name,v.shipping_owner_name,v.departure_transport,v.departure_carrier,v.consignee,v.shipping_order_container_id from container_storage_period_view v where v.id='"+row.id+"')t");
   assert.equal(row.receivingClientName,source.client_name);assert.equal(row.receivingOwnerName,others[1].name);
   assert.equal(row.arrivalTransport,source.arrival_transport);
   assert.equal(row.arrivalParty,source.arrival_transport==='VEHICLE'?source.arrival_carrier:source.consignor);
   assert.equal(row.arrivalCargo,source.cargo_name);
   assert.equal(row.shippingClientName??null,source.shipping_client_name);assert.equal(row.shippingOwnerName??null,source.shipping_owner_name);
   assert.equal(row.departureTransport??null,source.departure_transport);
   assert.equal(row.departureParty??null,source.departure_transport==='VEHICLE'?source.departure_carrier:source.consignee);
   if(row.endOrderType==='SHIPPING_ORDER')assert.equal(row.departureCargo,products[2].code);
   else for(const field of ['shippingClientName','shippingOwnerName','departureTransport','departureParty','departureCargo'])assert.equal(row[field]??null,null);
  }
  await checkCsv(rows,code);return rows;
 }
 const r=await manual('receiving');await confirm('receiving',r.id);assert.equal((await report()).length,0);
 await finish('receiving',r.id);let rows=await report();assert.equal(rows.length,1);assert.equal(rows[0].startOrderId,r.id);
 assert.equal(rows[0].storageDays,1);
 assert.equal(rows[0].arrivalCargo,products.slice(0,2).map(p=>p.code).sort().join('; '));
 assert.equal(rows[0].receivingClientName,party);assert.equal(rows[0].receivingOwnerName,others[1].name);
 assert.equal(rows[0].arrivalParty,catalogs[0][0].name);
 const first=rows[0].id;await clock('2026-09-17');const ch1=await change(others[0].id),ch2=await change(owner);
 rows=await report();assert.equal(rows.length,3);assert.equal(rows.find(p=>p.id===first).endOrderId,ch1);
 const open=rows.find(p=>p.status==='OPEN');assert.equal(open.startOrderId,ch2);assert.equal(open.ownerName,party);
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
 const departure=await manual('shipping',true);await confirm('shipping',departure.id,true);await finish('shipping',departure.id);
 const repeat=await manual('receiving');await confirm('receiving',repeat.id);await finish('receiving',repeat.id);
 rows=await report();assert.equal(rows.length,2);assert.equal(rows.find(p=>p.status==='OPEN').startOrderId,repeat.id);assert.equal(rows.find(p=>p.id===railPeriod.id).endOrderId,departure.id);
 // Keep the two different visits for browser checks; cancellation was covered above.
 assert.equal(rows.find(p=>p.id===railPeriod.id).departureTransport,'RAILWAY');
 assert.equal(rows.find(p=>p.id===railPeriod.id).departureParty,party);
 const filtered=await api('/container-storage-periods?size=1&query='+code);assert.equal(filtered.totalElements,2);assert.equal(filtered.items.length,1);
 assert.equal((await api('/container-storage-periods?size=1&page=1&query='+code)).items.length,1);
 for(const invalid of ['status=INVALID','arrivalFrom=2026-02-01&arrivalTo=2026-01-01','asOf=9999-12-31'])await api('/container-storage-periods?'+invalid,'GET',undefined,400);
 assert.equal((await api('/container-storage-periods?clientId='+shippingContract.client_id+'&query='+code)).totalElements,0);
 assert.equal((await api('/container-storage-periods?clientId='+owner+'&query='+code)).totalElements,2);
 console.log('UI fixture container:',code);
 console.log('PASS: auto/rail arrivals, same-day owner changes, owner-change to departure, cancellation/reopening, cancelled chain exclusion, repeated visits; 17-column CSV, different clients/owners, separate incoming/outgoing cargo, auto carriers and railway parties; boundaries match the original VIEW');
 }finally{await clock(saved.mode==='SYSTEM'?null:saved.date);}
})().catch(e=>{console.error(e);process.exitCode=1});
