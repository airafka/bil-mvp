const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const session=JSON.parse(fs.readFileSync('database/return-owner-20261109-session.json','utf8').replace(/^\uFEFF/,''));assert.match(session.database,/^billing_next_return_owner_/);
const docker='C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';const info=JSON.parse(execFileSync(docker,['inspect',session.backend],{windowsHide:true,encoding:'utf8'}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+session.database));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',session.database,'-At','-v','ON_ERROR_STOP=1','-c',q],{windowsHide:true,encoding:'utf8'}).trim();
async function api(p,body,status=200,method='POST'){const r=await fetch('http://localhost:8192/api'+p,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
(async()=>{
const service=(await api('/comprehensive-service-orders/available-services'))[0];const pair=JSON.parse(sql("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active and complex_service_id='"+service.id+"' limit 1)t"));
const other=(await api('/shipping-orders/return-contracts')).find(c=>c.clientId!==pair.client_id);assert.ok(other);
const clients=await api('/references/clients?limit=100');const owner=clients.find(c=>c.id!==pair.client_id&&c.id!==other.clientId)||clients.find(c=>c.id!==other.clientId);assert.ok(owner);
const bill=await api('/waybills/generate',{standard20:7,standard40:1},201);
const created=await api('/comprehensive-service-orders',{clientId:pair.client_id,contractId:pair.contract_id,complexServiceId:service.id,defaultContainerOwnerId:pair.client_id,waybillIds:[bill.id]},201);const id=created.order.id,cs=created.receivingOrder.containers,ids=cs.map(c=>c.containerId);
await api('/receiving-orders/'+created.receivingOrder.id+'/containers',{containers:[{containerId:ids[0],ownerClientId:owner.id}]},200,'PATCH');
const count=()=>sql("select (select count(*) from receiving_order)||':'||(select count(*) from comprehensive_service_order)");
const payload={containerIds:[ids[2],ids[3]],useCurrentClient:false,clientId:other.clientId,contractId:other.contractId};const before=count();
assert.equal((await api('/comprehensive-service-orders/'+id+'/returns',payload,400)).code,'RETURN_OWNER_REQUIRED');assert.equal(count(),before);
assert.equal((await api('/comprehensive-service-orders/'+id+'/returns',{...payload,ownerClientId:'00000000-0000-0000-0000-000000000000'},400)).code,'RETURN_OWNER_NOT_FOUND');assert.equal(count(),before);
const own=await api('/comprehensive-service-orders/'+id+'/returns',{containerIds:[ids[0],ids[1]],useCurrentClient:true,ownerClientId:other.clientId},201);
for(const r of own.returns){const d=await api('/receiving-orders/'+r.receivingOrderId);const c=d.containers[0];assert.equal(c.ownerClientId,c.containerId===ids[0]?owner.id:pair.client_id);assert.equal(d.comprehensiveServiceOrderId,id);}
const foreign=await api('/comprehensive-service-orders/'+id+'/returns',{...payload,ownerClientId:owner.id},201);assert.notEqual(foreign.serviceOrderId,id);
for(const r of foreign.returns){const d=await api('/receiving-orders/'+r.receivingOrderId);assert.equal(d.clientId,other.clientId);assert.equal(d.defaultContainerOwnerId,owner.id);assert.equal(d.containers[0].ownerClientId,owner.id);}
const candidates=await api('/comprehensive-service-orders/'+id+'/returns/available-containers');const single=candidates.find(c=>c.containerId===ids[4]);
await api('/shipping-orders/'+single.shippingOrderId+'/returns',{...payload,containerIds:[ids[4]]},400);
const one=await api('/shipping-orders/'+single.shippingOrderId+'/returns',{...payload,containerIds:[ids[4]],ownerClientId:owner.id},201);assert.equal((await api('/receiving-orders/'+one.receivingOrderId)).containers[0].ownerClientId,owner.id);
const complete=async(s,section)=>{await api('/comprehensive-service-orders/'+s+'/prepare-transport',{section});await api('/comprehensive-service-orders/'+s+'/complete-section',{section,action:'CONFIRM_ROUTES'});await api('/comprehensive-service-orders/'+s+'/complete-section',{section,action:'COMPLETE_ORDERS'});};
await complete(id,'INITIAL_RECEIVING');await complete(id,'SHIPPING');await complete(foreign.serviceOrderId,'RETURN_RECEIVING');
for(const r of foreign.returns){const d=await api('/receiving-orders/'+r.receivingOrderId);assert.equal(d.status,'COMPLETED');assert.equal(d.containers[0].ownerClientId,owner.id);}
const original=await api('/receiving-orders/'+created.receivingOrder.id);assert.equal(original.containers.find(c=>c.containerId===ids[0]).ownerClientId,owner.id);assert.equal(original.containers.find(c=>c.containerId===ids[2]).ownerClientId,pair.client_id);
fs.writeFileSync('database/return-owner-20261109-api.json',JSON.stringify({database:session.database,id,pair,other,owner,ids,own,foreign,one,remaining:candidates.filter(c=>c.containerId!==ids[4]),checks:['missing owner rejected atomically','invalid owner rejected atomically','original individual owners preserved for same client despite supplied override','chosen owner on every foreign return and default','single shipping endpoint validated','foreign returns completed with chosen owner','source owners unchanged']},null,2));console.log('PASS return owner API and lifecycle',id);
})().catch(e=>{console.error(e);process.exitCode=1});