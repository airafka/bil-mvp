// Mutating checks: prepared isolated database only. Never point this at the working application.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process'),{randomUUID}=require('crypto');
const session=JSON.parse(fs.readFileSync('database/auto20-20261109-session.json','utf8').replace(/^\uFEFF/,''));
assert.match(session.database,/^billing_next_auto20_\d{8}_\d{6}$/);
const docker='C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const info=JSON.parse(execFileSync(docker,['inspect',session.backend],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(info.Config.Env.includes('DB_NAME='+session.database));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8192'));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',session.database,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();
const json=q=>JSON.parse(sql(q));
async function api(path,method='GET',body,status=200){const r=await fetch('http://localhost:8192/api'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data}
(async()=>{
const services=await api('/comprehensive-service-orders/available-services');assert.equal(services.length,2);
const cases=[];let fixture;
for(const service of services){
 const pair=json("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active and complex_service_id='"+service.id+"' limit 1)t");assert.ok(pair);
 const request=bill=>({clientId:pair.client_id,contractId:pair.contract_id,complexServiceId:service.id,defaultContainerOwnerId:pair.client_id,waybillIds:[bill.id]});
 for(const count of [3,39,40,41]){
  const bill=await api('/waybills/generate','POST',{standard20:count-1,standard40:1},201);
  const created=await api('/comprehensive-service-orders','POST',request(bill),201);
  assert.equal(created.receivingOrder.containers.length,count);assert.equal(created.shippingOrders.length,count);
  assert.equal(created.selectableContainers.length,0);assert.equal(created.returnOrders.length,0);
  const linked=json("select json_agg(t) from (select sh.id,count(sc.id) as containers from shipping_order sh join shipping_order_container sc on sc.shipping_order_id=sh.id where sh.comprehensive_service_order_id='"+created.order.id+"' group by sh.id)t");
  assert.equal(linked.length,count);assert.ok(linked.every(x=>x.containers===1));
  const sourceIds=json("select json_agg(container_id order by container_id) from shipping_order_source_container where comprehensive_service_order_id='"+created.order.id+"'");
  assert.deepEqual(sourceIds,[...created.receivingOrder.containers.map(c=>c.containerId)].sort());
  const first20=created.receivingOrder.containers.find(c=>sourceIds.includes(c.containerId)&&sql("select container_type from container where id='"+c.containerId+"'")==='STANDARD_20');
  assert.ok(first20);
  const duplicate=await api('/comprehensive-service-orders/'+created.order.id+'/shipping-orders','POST',{containerIds:[first20.containerId]},409);assert.equal(duplicate.code,'CONTAINER_ALREADY_SHIPPED');
  await api('/comprehensive-service-orders','POST',request(bill),409);
  const reread=await api('/comprehensive-service-orders/'+created.order.id);assert.equal(reread.shippingOrders.length,count);
  cases.push({service:service.name,containers:count,shipping:created.shippingOrders.length,id:created.order.id});
 }
 const bill=await api('/waybills/generate','POST',{standard20:2,standard40:1},201);
 const snapshot=()=>sql("select json_build_array((select count(*) from comprehensive_service_order),(select count(*) from receiving_order),(select count(*) from shipping_order),(select receiving_order_id from waybill where id='"+bill.id+"'))");
 const before=snapshot();
 await api('/comprehensive-service-orders','POST',{...request(bill),complexServiceId:randomUUID()},400);
 await api('/comprehensive-service-orders','POST',{...request(bill),waybillIds:[]},400);
 await api('/comprehensive-service-orders','POST',{...request(bill),waybillIds:[randomUUID()]},404);
 await api('/comprehensive-service-orders','POST',{...request(bill),containerOwners:[{containerId:randomUUID(),ownerClientId:pair.client_id}]},404);
 assert.equal(snapshot(),before,'Invalid input must not create partial orders');
 // Prefer the train service with a small waybill for the browser regression.
 const minimum=Number(sql("select coalesce(min_waybill_containers,0) from complex_service_catalog where id='"+service.id+"'"));
 if(minimum>=40)fixture={service:service.id,client:pair.client_id,contract:pair.contract_id,bill:json("select json_build_object('id',id,'number',number,'departureStation',departure_station,'destinationStation',destination_station,'payer',payer) from waybill_details where id='"+bill.id+"'")};
}
assert.ok(fixture);fs.writeFileSync('database/auto20-20261109-check.json',JSON.stringify({database:session.database,cases,ui:fixture,checks:['both railway services accept 3/39/40/41 containers','one shipping order per 20/40 container','no automatic returns','no unassigned containers','duplicate shipping and waybill reuse rejected','invalid input rolls back']},null,2));
console.log('PASS',cases.length,'creation scenarios; duplicates and rollback; UI fixture ready');
})().catch(e=>{console.error(e);process.exitCode=1});
