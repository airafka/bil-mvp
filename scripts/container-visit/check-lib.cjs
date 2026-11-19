const assert=require('node:assert/strict');
const {run,sql:query,fs}=require('./ops.cjs');
const pg='billing-visit-check-db',db='billing_visit_check',base='http://127.0.0.1:8235/api';
const sql=q=>query(pg,db,q),json=q=>JSON.parse(sql(q));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
async function init(backend='billing-visit-check-old'){
 assert.equal(sql('select current_database()'),db);
 const inspect=JSON.parse(run(['inspect',backend]))[0];assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.Config.Env.includes('DB_HOST='+pg));assert.deepEqual(Object.keys(inspect.NetworkSettings.Networks),['billing-visit-check']);
 assert.equal(inspect.Config.Labels['billing.task'],'visit-check');assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='8235'));
 const database=JSON.parse(run(['inspect',pg]))[0];assert.equal(database.Config.Labels['billing.task'],'visit-check');assert.ok(database.Mounts.every(m=>m.Type==='tmpfs'));assert.deepEqual(Object.keys(database.NetworkSettings.Networks),['billing-visit-check']);
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const clients=await api('/references/clients'),a=tariff.client_id,[b,c]=clients.filter(x=>x.id!==a).slice(0,2).map(x=>x.id),party=clients.find(x=>x.id===a).name;
 const area=(await api('/references/terminal-areas')).find(x=>x.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 async function generated(){const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);return sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}' limit 1`);}
 async function transport(kind,ktk,receivingOwner=a){return api('/'+kind+'-orders','POST',{clientId:a,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',arrivalAt:'2026-09-15T12:00:00',departureAt:'2026-09-15T12:00:00',consignor:party,consignee:party,...(kind==='receiving'?{defaultContainerOwnerId:receivingOwner}:{}),containers:[{containerId:ktk,empty:true,ownerClientId:receivingOwner}]},201);}
 async function confirm(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-09-15T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});return r.route.id;}
 const finish=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'},status);
 async function arrival(ktk,owner=a,completed=true){ktk=ktk||await generated();const r=await transport('receiving',ktk,owner);await confirm('receiving',r.id);if(completed)await finish('receiving',r.id);return {ktk,receiving:r.id};}
 async function ship(ktk,completed=true){const r=await transport('shipping',ktk);await confirm('shipping',r.id);if(completed)await finish('shipping',r.id);return r.id;}
 async function create(ktks,next,date){return (await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',effectiveDate:date,containerOwnerIds:ktks.map(k=>sql(`select id from container_owner where container_id='${k}'`))},201)).order.id;}
 async function schedule(ktks,next,date){const id=await create(ktks,next,date);await api('/service-orders/'+id+'/accept','POST');return id;}
 async function waitStatus(id,status='DONE'){for(let n=0;n<100;n++){if(sql(`select status from service_order where id='${id}'`)===status)return;await pause(300);}throw Error('Scheduler status '+id+': '+sql(`select row_to_json(s) from service_order s where id='${id}'`));}
 const report=ktk=>api('/container-storage-periods?size=100&query='+sql(`select code from container where id='${ktk}'`));
 const cancel=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{reason:'Изолированная проверка',expectedStatus:sql(`select order_status from ${kind}_order where id='${id}'`)},status);
 return {a,b,c,generated,transport,confirm,finish,arrival,ship,create,schedule,waitStatus,report,cancel};
}
async function capture(){let values={};for(const p of ['/container-storage-periods?size=100','/container-storage-periods?size=100&status=ALL','/container-storage-periods/export','/container-storage-periods/export?status=CLOSED']){const r=await fetch(base+p);assert.equal(r.status,200);values[p]=await r.text();}return values;}
module.exports={assert,run,sql,json,fs,api,clock,pause,init,capture};
