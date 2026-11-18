// Mutating smoke test only on the fresh, explicitly cleared release copy.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_storage_chain_release_test',base='http://127.0.0.1:8221/api';
const info=JSON.parse(execFileSync(docker,['inspect','billing-next-storage-chain-release-test'],{encoding:'utf8'}))[0];
assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8221'));
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8'}).trim();
const json=q=>JSON.parse(sql(q));assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'53');
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const s=await r.text();assert.equal(r.status,status,p+': '+s);return s?JSON.parse(s):null;}
async function main(){
 for(const t of ['container_owner','container_owner_history','container_storage_period','receiving_order','shipping_order','service_order','comprehensive_service_order','route','waybill','billing_charge','payment_invoice'])assert.equal(sql('select count(*) from '+t),'0',t);
 assert.deepEqual((await api('/container-storage-periods')).items,[]);
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const clients=await api('/references/clients'),owner=tariff.client_id,other=clients.find(c=>c.id!==owner).id,party=clients.find(c=>c.id===owner).name;
 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 const b=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);
 const c=sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${b.id}' limit 1`);
 async function create(kind){return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),arrivalAt:'2026-11-01T12:00:00',departureAt:'2026-11-01T12:00:00',consignor:party,consignee:party,containers:[{containerId:c,empty:true,ownerClientId:kind==='receiving'?owner:other}]},201);}
 async function finish(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-11-01T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});await api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});}
 const receipt=await create('receiving');await finish('receiving',receipt.id);
 const stock=sql(`select id from container_owner where container_id='${c}'`);
 const change=await api('/service-orders','POST',{clientId:other,service:'CHANGE_OWNER',containerOwnerIds:[stock]},201);
 await api('/service-orders/'+change.order.id+'/accept','POST');
 assert.equal(sql(`select count(*) from container_storage_period where container_id='${c}'`),'2');
 assert.equal(sql(`select count(*) from container_storage_period where container_id='${c}' and storage_receiving_order(id)='${receipt.id}'`),'2');
 const shipment=await create('shipping');await finish('shipping',shipment.id);
 await api('/shipping-orders/'+shipment.id+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'Проверка после очистки'});
 assert.equal(sql(`select status from container_owner where container_id='${c}'`),'ON_TERMINAL');
 assert.equal(sql(`select client_id from container_owner where container_id='${c}'`),other);
 await api('/receiving-orders/'+receipt.id+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'Проверка после очистки'});
 assert.equal(sql(`select count(*) from container_storage_period where container_id='${c}' and status='CANCELLED'`),'2');
 assert.deepEqual((await api('/container-storage-periods')).items,[]);
 console.log('PASS: empty report, preserved catalogs, new waybill/receipt, owner change, shipping and both cancellations after complete reset');
}
main().catch(e=>{console.error(e);process.exitCode=1});
