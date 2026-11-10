
// Mutations only on the prepared isolated billing-next-owner-create-test database.
const fs=require('fs'),assert=require('node:assert/strict'),{randomUUID}=require('crypto'),{execFileSync}=require('child_process');
const docker='C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe',session=JSON.parse(fs.readFileSync('database/service-owner-test-session.json'));assert.match(session.db,/^billing_next_owner_create_\d{8}_\d{6}$/);
const inspect=JSON.parse(execFileSync(docker,['inspect','billing-next-owner-create-test'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(inspect.Config.Env.includes('DB_NAME='+session.db));assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8192'));
const user=inspect.Config.Env.find(e=>e.startsWith('DB_USER=')).slice(8);const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U',user,'-d',session.db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();
async function api(path,method='GET',body,status=200){const r=await fetch('http://localhost:8192/api'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data}
(async()=>{
 const service=(await api('/comprehensive-service-orders/available-services')).find(s=>s.maxWaybillContainers===39);
 const pair=JSON.parse(sql("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active and complex_service_id='"+service.id+"' limit 1)t"));
 const owners=JSON.parse(sql("select json_agg(id) from client where id<>'"+pair.client_id+"'"));assert.ok(owners.length);
 const generate=()=>api('/waybills/generate','POST',{standard20:1,standard40:2},201);
 const request=bill=>({clientId:pair.client_id,contractId:pair.contract_id,complexServiceId:service.id,defaultContainerOwnerId:pair.client_id,waybillIds:[bill.id]});
 const bill=await generate();const ids=sql("select wc.container_id from waybill_container wc join waybill_railway_carriage w on w.id=wc.waybill_railway_carriage_id where w.waybill_id='"+bill.id+"' order by wc.container_id").split('\n');assert.equal(ids.length,3);
 const snapshot=()=>sql("select json_build_array((select count(*) from comprehensive_service_order),(select count(*) from receiving_order),(select count(*) from shipping_order),(select receiving_order_id from waybill where id='"+bill.id+"'),(select json_agg(wc.owner_container_id order by wc.id) from waybill_container wc join waybill_railway_carriage w on w.id=wc.waybill_railway_carriage_id where w.waybill_id='"+bill.id+"'))");
 const before=snapshot();
 for(const [changes,status] of [
  [[{containerId:ids[0],ownerClientId:owners[0]},{containerId:randomUUID(),ownerClientId:owners[0]}],404],
  [[{containerId:ids[0],ownerClientId:owners[0]},{containerId:ids[1],ownerClientId:randomUUID()}],404],
  [[{containerId:ids[0],ownerClientId:owners[0]},{containerId:ids[0],ownerClientId:pair.client_id}],400],
  [[{containerId:ids[0],ownerClientId:null}],400]
 ]){await api('/comprehensive-service-orders','POST',{...request(bill),containerOwners:changes},status);assert.equal(snapshot(),before,'Invalid owners must roll back entire creation')}
 const created=await api('/comprehensive-service-orders','POST',{...request(bill),containerOwners:[{containerId:ids[0],ownerClientId:owners[0]}]},201);
 const saved=await api('/comprehensive-service-orders/'+created.order.id);for(const c of saved.receivingOrder.containers)assert.equal(c.ownerClientId,c.containerId===ids[0]?owners[0]:pair.client_id);
 const second=await generate(),legacy=await api('/comprehensive-service-orders','POST',request(second),201);assert.ok(legacy.receivingOrder.containers.every(c=>c.ownerClientId===pair.client_id));
 const uiBill=await generate();const billDetails=JSON.parse(sql("select json_build_object('id',id,'number',number,'departureStation',departure_station,'destinationStation',destination_station,'payer',payer) from waybill_details where id='"+uiBill.id+"'"));
 fs.writeFileSync('database/service-owner-create-check.json',JSON.stringify({db:session.db,serviceId:created.order.id,receiptId:created.receivingOrder.id,checks:['individual owner persisted','default preserved','invalid owner rollback','foreign container rollback','duplicate rejected','null rejected','legacy request accepted'],ui:{service:service.id,client:pair.client_id,contract:pair.contract_id,otherOwner:owners[0],bill:billDetails}},null,2));console.log('PASS service owner creation and rollback; UI fixture ready');
})().catch(e=>{console.error(e);process.exitCode=1});
