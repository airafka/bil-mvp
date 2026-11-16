// Mutating checks: dedicated database and backend only. Never point this at billing_next.
const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_no_return_test',base='http://127.0.0.1:8195/api';
const inspect=JSON.parse(execFileSync(docker,['inspect','billing-next-no-return-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(inspect.Config.Env.includes('DB_NAME='+db));
assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8195'));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();
assert.equal(sql('select current_database()'),db);
assert.equal(sql('select max(version::integer) from flyway_schema_history where success'),'32');
const json=q=>JSON.parse(sql(q));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let value;try{value=JSON.parse(text)}catch{value=text}assert.equal(r.status,status,p+': '+text);return value}
const service=id=>api('/comprehensive-service-orders/'+id);
const select=(id,ids,status=200)=>api('/comprehensive-service-orders/'+id+'/no-return','POST',{containerIds:ids},status);
const returns=(id,ids,status=201)=>api('/comprehensive-service-orders/'+id+'/returns','POST',{containerIds:ids,useCurrentClient:true},status);
const candidates=id=>api('/comprehensive-service-orders/'+id+'/returns/available-containers');
const cancel=(id,expectedStatus,status=200)=>api('/shipping-orders/'+id+'/cancellation','POST',{expectedStatus,reason:'Изолированная проверка: возврат не нужен'},status);
const count=id=>Number(sql("select count(*) from service_execution where comprehensive_service_order_id='"+id+"'"));
const finish=id=>api('/shipping-orders/'+id+'/events','POST',{eventCode:'LOAD_FINISH'});
async function completePart(id,section){await api('/comprehensive-service-orders/'+id+'/prepare-transport','POST',{section});await api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section,action:'CONFIRM_ROUTES'});return api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section,action:'COMPLETE_ORDERS'})}
(async()=>{
 const catalogs=await api('/comprehensive-service-orders/available-services');assert.equal(catalogs.length,2);
 const tariff=svc=>json("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='"+svc.id+"' and active order by id limit 1)t");
 async function fixture(svc=catalogs[0],n=1){const t=tariff(svc),bill=await api('/waybills/generate','POST',{standard20:n,standard40:0},201);return api('/comprehensive-service-orders','POST',{complexServiceId:svc.id,clientId:t.client_id,contractId:t.contract_id,defaultContainerOwnerId:t.client_id,waybillIds:[bill.id]},201)}
 // Both railway services: decision before completion, no early charge, completion without return, idempotency.
 for(const catalog of catalogs){const s=await fixture(catalog),id=s.order.id,c=s.receivingOrder.containers[0].containerId,sh=s.shippingOrders[0].id;
  await select(id,[c]);assert.equal(count(id),0);assert.equal((await service(id)).progress.returnMissing,0);
  await completePart(id,'INITIAL_RECEIVING');assert.equal(count(id),0);
  const d=await completePart(id,'SHIPPING');assert.equal(d.order.status,'COMPLETED');assert.equal(count(id),1);
  const execution=json("select row_to_json(e) from service_execution e where comprehensive_service_order_id='"+id+"'");
  assert.equal(execution.receiving_order_id,null);assert.equal(execution.shipping_order_id,sh);
  const listed=await api('/billing-charges?comprehensiveServiceOrderId='+id);
  assert.equal(listed.total,1);assert.equal(listed.items.length,1);assert.equal(listed.items[0].receivingOrderId??null,null);assert.equal(listed.items[0].receivingOrderCode??null,null);assert.equal(listed.items[0].shippingOrderId,sh);
  assert.equal(sql("select count(*) from service_execution e join comprehensive_service_order_tariff t on t.comprehensive_service_order_id=e.comprehensive_service_order_id where e.comprehensive_service_order_id='"+id+"' and e.price_with_vat=t.price_with_vat and e.price_without_vat=t.price_without_vat"),'1');
  await Promise.all([select(id,[c]),select(id,[c]),finish(sh)]);assert.equal(count(id),1);
  assert.equal((await candidates(id)).length,0);
  assert.equal((await returns(id,[c],409)).code,'RETURN_CONTAINERS_UNAVAILABLE');
  assert.equal((await api('/shipping-orders/'+sh+'/returns','POST',{containerIds:[c],useCurrentClient:true},409)).code,'RETURN_NOT_REQUIRED');
 }
 console.log('PASS: both railway services, shipping-triggered tariff charge, no-return completion, duplicate protection, both return APIs');
 // Two KTK20 in one shipment: only one bypasses return; the other remains on the ordinary path.
 let s=await fixture(catalogs[0],2),id=s.order.id,ids=s.receivingOrder.containers.map(c=>c.containerId);
 for(const sh of s.shippingOrders)await cancel(sh.id,'DRAFT');
 s=await api('/comprehensive-service-orders/'+id+'/shipping-orders','POST',{containerIds:ids},201);
 const mixedShipment=s.shippingOrders.find(sh=>sh.status==='DRAFT').id;
 await select(id,[ids[0]]);await completePart(id,'INITIAL_RECEIVING');await completePart(id,'SHIPPING');
 assert.equal(count(id),1);assert.notEqual((await service(id)).order.status,'COMPLETED');assert.equal((await service(id)).progress.returnMissing,1);
 assert.deepEqual((await candidates(id)).map(c=>c.containerId),[ids[1]]);
 const ret=await returns(id,[ids[1]]);assert.equal((await select(id,[ids[1]],409)).code,'NO_RETURN_CONTAINERS_UNAVAILABLE');
 await completePart(id,'RETURN_RECEIVING');assert.equal(count(id),2);assert.equal((await service(id)).order.status,'COMPLETED');
 await api('/receiving-orders/'+ret.returns[0].receivingOrderId+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'Проверка обычного возврата'});
 assert.equal(count(id),1,'return cancellation preserves shipping-triggered charge');
 await cancel(mixedShipment,'COMPLETED');assert.equal(count(id),0);assert.equal((await service(id)).progress.returnMissing,2);
 assert.equal(sql("select jsonb_array_length(billing_snapshot) from order_cancellation where order_id='"+mixedShipment+"'"),'1');
 console.log('PASS: per-container choice inside one shipment, mixed completion, return conflict, separate financial reversals');
 // Late decision accrues now, not at the old shipping date; invalid batch rolls back in full.
 s=await fixture(catalogs[1],2);id=s.order.id;ids=s.receivingOrder.containers.map(c=>c.containerId);
 await completePart(id,'INITIAL_RECEIVING');await completePart(id,'SHIPPING');assert.equal(count(id),0);
 const other=await fixture(),foreign=other.receivingOrder.containers[0].containerId;
 await select(id,[ids[0],foreign],409);assert.equal(count(id),0);
 assert.equal(sql("select count(*) from shipping_order_container sc join shipping_order sh on sh.id=sc.shipping_order_id where sh.comprehensive_service_order_id='"+id+"' and not sc.return_required"),'0');
 await select(id,[ids[0],ids[0]],409);await select(id,[],400);
 const selectedAt=Date.now();await select(id,ids);assert.equal(count(id),2);assert.equal((await service(id)).order.status,'COMPLETED');
 const charges=json("select json_agg(b) from billing_charge b join service_execution e on e.id=b.service_execution_id where e.comprehensive_service_order_id='"+id+"'");
 assert.ok(charges.every(c=>new Date(c.performed_at).getTime()>=selectedAt-1000));
 const charge=charges[0],period=new Date(charge.performed_at).toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'}).slice(0,7);
 const shid=sql("select shipping_order_id from service_execution where id='"+charge.service_execution_id+"'");
 const invoice=await api('/payment-invoices','POST',{clientId:s.order.clientId,contractId:s.order.contractId,period,chargeIds:[charge.id],requestKey:crypto.randomUUID()},201);
 assert.equal((await cancel(shid,'COMPLETED',409)).code,'CANCELLATION_INVOICED');assert.equal(count(id),2);
 assert.equal(sql("select count(*) from order_cancellation where order_id='"+shid+"'"),'0');
 await api('/payment-invoices/'+invoice.invoice.id,'DELETE',undefined,204);await cancel(shid,'COMPLETED');assert.equal(count(id),1);
 const cancelledContainer=sql("select container_id from shipping_order_container where shipping_order_id='"+shid+"'");
 await select(id,[cancelledContainer],409);
 const replacement=await api('/comprehensive-service-orders/'+id+'/shipping-orders','POST',{containerIds:[cancelledContainer]},201);
 assert.ok((await candidates(id)).some(c=>c.containerId===cancelledContainer),'replacement starts with required return');
 await select(id,[cancelledContainer]);await completePart(id,'SHIPPING');assert.equal(count(id),2);
 const newShip=replacement.shippingOrders.find(o=>o.status==='DRAFT').id;
 assert.equal(sql("select shipping_order_id from service_execution where comprehensive_service_order_id='"+id+"' and container_id='"+cancelledContainer+"'"),newShip);
 assert.equal((await service(id)).order.status,'COMPLETED');
 console.log('PASS: late selection, atomic validation, invoice guard/rollback, audited cancellation, replacement and re-accrual');
 // Concurrent return and no-return actions must not both succeed.
 s=await fixture();id=s.order.id;const c=s.receivingOrder.containers[0].containerId;
 const responses=await Promise.all(['/no-return','/returns'].map(path=>fetch(base+'/comprehensive-service-orders/'+id+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({containerIds:[c],useCurrentClient:true})})));
 assert.equal(responses.filter(r=>r.ok).length,1);assert.equal(responses.filter(r=>r.status===409).length,1);
 console.log('PASS: concurrent return/no-return selection is mutually exclusive');
 // Browser fixture: one completed and one confirmed shipment, no selection yet.
 s=await fixture(catalogs[0],2);id=s.order.id;await completePart(id,'INITIAL_RECEIVING');
 await api('/comprehensive-service-orders/'+id+'/prepare-transport','POST',{section:'SHIPPING'});
 await api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section:'SHIPPING',action:'CONFIRM_ROUTES'});
 await finish(s.shippingOrders[0].id);
 fs.writeFileSync('backups/no-return-fixture.json',JSON.stringify({db,service:id,shipping:s.shippingOrders.map(o=>o.id),containers:s.receivingOrder.containers.map(c=>({id:c.containerId,name:c.containerName})),otherService:other.order.id}));
 console.log('PASS: browser fixture saved; all changes confined to '+db);
})().catch(error=>{console.error(error);process.exitCode=1});
