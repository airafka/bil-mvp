// V58 regression: only a disposable isolated copy; never connects to billing_next.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_remove_ledgers_test',pg='billing-remove-ledgers-db',base='http://127.0.0.1:8285/api';
const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
const info=JSON.parse(run(['inspect','billing-remove-ledgers-backend']))[0],database=JSON.parse(run(['inspect',pg]))[0];
assert.ok(info.Config.Env.includes('DB_NAME='+db));assert.ok(info.Config.Env.includes('DB_HOST='+pg));assert.equal(info.Config.Labels['billing.task'],'remove-ledgers-v58');assert.ok(database.Mounts.every(m=>m.Type==='tmpfs'));
assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8285'));
const sql=q=>run(['exec','-i',pg,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q),json=q=>JSON.parse(sql(q));
assert.equal(sql('select current_database()'),db);assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'58');
for(const table of ['container_movement','order_cancellation','outbound_data'])assert.equal(sql(`select to_regclass('public.${table}') is null`),'t');
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let value;try{value=JSON.parse(text)}catch{value=text}assert.equal(r.status,status,p+': '+text);return value}
const get=(kind,id)=>api('/'+kind+'-orders/'+id);
const cancel=(kind,id,expectedStatus,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus},status);
const finish=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'},status);
const stock=id=>json("select row_to_json(o) from container_owner_current o where container_id='"+id+"'");
const section=(id,section,action)=>api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section,action});
const prepare=(id,section)=>api('/comprehensive-service-orders/'+id+'/prepare-transport','POST',{section});
async function confirmPart(id,part){await prepare(id,part);return section(id,part,'CONFIRM_ROUTES')}
async function completePart(id,part){await confirmPart(id,part);return section(id,part,'COMPLETE_ORDERS')}
(async()=>{
 const service=(await api('/comprehensive-service-orders/available-services'))[0];
 const tariff=json("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='"+service.id+"' and active order by id limit 1)t");
 const owner=tariff.client_id,other=sql("select id from client where id<>'"+owner+"' order by id limit 1");
 const parties=await api('/references/clients'),party=parties.find(p=>p.id===owner).name;
 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 async function fixture(){const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);const s=await api('/comprehensive-service-orders','POST',{complexServiceId:service.id,clientId:owner,contractId:tariff.contract_id,defaultContainerOwnerId:owner,waybillIds:[bill.id]},201);return {s,bill,c:s.receivingOrder.containers[0].containerId}}
 async function manual(kind,containers,newOwner=owner){return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:newOwner}:{}),arrivalAt:'2026-11-10T12:00:00',departureAt:'2026-11-10T12:00:00',consignor:party,consignee:party,containers:containers.map(containerId=>({containerId,empty:true,ownerClientId:newOwner}))},201)}
 async function route(kind,ids){return api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-11-10T12:00:00+03:00',...logistics,orderIds:ids},201)}
 const confirmRoute=(id,status=200)=>api('/routes/'+id+'/confirm','POST',{},status);
 async function confirmManual(kind,id){const r=await route(kind,[id]);await confirmRoute(r.route.id);return r.route.id}
 // Draft cancellation has no stock side effects; railway composition is released without an archive.
 let a=await fixture(),root=a.s.order.id,rid=a.s.receivingOrder.id,sid=a.s.shippingOrders[0].id;
 assert.equal((await cancel('receiving',rid,'DRAFT',409)).code,'CANCELLATION_DEPENDENT_ORDERS');
 await cancel('shipping',sid,'DRAFT');
 let d=await api('/comprehensive-service-orders/'+root);assert.equal(d.selectableContainers.length,1);assert.equal(d.shippingOrders[0].status,'CANCELLED');
 d=await api('/comprehensive-service-orders/'+root+'/shipping-orders','POST',{containerIds:[a.c]},201);
 const replacement=d.shippingOrders.find(o=>o.status==='DRAFT');assert.ok(replacement,'shipment can be recreated');
 await cancel('shipping',replacement.id,'DRAFT');await cancel('receiving',rid,'DRAFT');
 assert.equal(sql("select count(*) from container_owner where container_id='"+a.c+"'"),'0');
 assert.equal((await get('receiving',rid)).waybills.length,0);
 assert.equal((await api('/comprehensive-service-orders/'+root)).order.status,'CANCELLED');
 const reused=await api('/comprehensive-service-orders','POST',{complexServiceId:service.id,clientId:owner,contractId:tariff.contract_id,defaultContainerOwnerId:other,waybillIds:[a.bill.id]},201);
 assert.equal((await get('receiving',rid)).containers.length,0,'no cancellation archive after railway waybill release');
 assert.equal(reused.receivingOrder.containers[0].ownerClientId,other);
 console.log('PASS: draft, dependencies, released railway composition without archive, free waybills, replacement KTK20');
 // First confirmed receipt cancellation leaves DEPARTED record, unlinked previous receipt, repeat is idempotent.
 a=await fixture();const m=await manual('receiving',[a.c]);const mr=await confirmManual('receiving',m.id);
 assert.equal(stock(a.c).status,'EXPECTED');await cancel('receiving',m.id,'DRAFT',409);await cancel('receiving',m.id,'CONFIRMED');await cancel('receiving',m.id,'CONFIRMED');
 assert.equal(stock(a.c).status,'DEPARTED');assert.equal(stock(a.c).receiving_order_id,null);
 assert.equal((await api('/routes/'+mr)).route.status,'CANCELLED');
 await finish('receiving',m.id,409);assert.equal((await get('receiving',m.id)).status,'CANCELLED');
 // Repeated cycle: owner before receiving is restored; cancellation of shipping preserves a subsequent ownership change.
 const m2=await manual('receiving',[a.c],other);await confirmManual('receiving',m2.id);await finish('receiving',m2.id);
 assert.equal(stock(a.c).client_id,other);
 const sh=await manual('shipping',[a.c]);await confirmManual('shipping',sh.id);
 assert.equal((await cancel('receiving',m2.id,'COMPLETED',409)).code,'CANCELLATION_STOCK_CONFLICT');
 const so=await api('/service-orders','POST',{clientId:owner,service:'CHANGE_OWNER',containerOwnerIds:[stock(a.c).id]},201);
 await api('/service-orders/'+so.order.id+'/containers','PUT',[{containerOwnerId:stock(a.c).id}]);await api('/service-orders/'+so.order.id+'/accept','POST',{});
 await cancel('shipping',sh.id,'CONFIRMED');assert.equal(stock(a.c).status,'ON_TERMINAL');assert.equal(stock(a.c).client_id,owner);
 await cancel('receiving',m2.id,'COMPLETED');assert.equal(stock(a.c).status,'DEPARTED');assert.equal(stock(a.c).client_id,owner);
 console.log('PASS: confirmed/completed reversal, previous/current owners, route, repeat protection, no cancellation reason');
 // Completed shipment cannot be cancelled after a subsequent receiving reservation.
 const m3=await manual('receiving',[a.c]);await confirmManual('receiving',m3.id);await finish('receiving',m3.id);
 const sh2=await manual('shipping',[a.c]);await confirmManual('shipping',sh2.id);await finish('shipping',sh2.id);
 const m4=await manual('receiving',[a.c],other);await confirmManual('receiving',m4.id);
 await cancel('shipping',sh2.id,'COMPLETED',409);await finish('receiving',m4.id);await cancel('shipping',sh2.id,'COMPLETED',409);
 await cancel('receiving',m4.id,'COMPLETED');assert.equal(stock(a.c).receiving_order_id,m3.id);assert.equal(stock(a.c).client_id,owner);
 await cancel('shipping',sh2.id,'COMPLETED');assert.equal(stock(a.c).status,'ON_TERMINAL');assert.equal(stock(a.c).shipping_order_id,null);
 // Atomic multi-container conflict with both numbers, then cancel only one member of a shared route.
 const b=await fixture(),c=await fixture();const bm=await manual('receiving',[b.c]),cm=await manual('receiving',[c.c]);
 const shared=await route('receiving',[bm.id,cm.id]);await confirmRoute(shared.route.id);await cancel('receiving',bm.id,'CONFIRMED');await finish('receiving',cm.id);
 assert.equal((await api('/routes/'+shared.route.id)).route.status,'COMPLETED');
 const dup=await manual('receiving',[a.c,c.c]);const dr=await route('receiving',[dup.id]);const conflict=await confirmRoute(dr.route.id,409);
 assert.equal(conflict.code,'CONTAINER_RESERVATION_CONFLICT');for(const id of [a.c,c.c])assert.ok(conflict.detail.includes(sql("select code from container where id='"+id+"'")));
 assert.equal((await get('receiving',dup.id)).status,'DRAFT');
 console.log('PASS: subsequent-operation guards, reverse chain, history preserved, partial-route cancellation, aggregate conflicts');
 // Full financial cycle: free charges reverse; invoices block atomically; cancelled returns can be re-created.
 const f=await fixture(),fid=f.s.order.id;await completePart(fid,'INITIAL_RECEIVING');await completePart(fid,'SHIPPING');
 async function createReturn(){return (await api('/comprehensive-service-orders/'+fid+'/returns','POST',{containerIds:[f.c],useCurrentClient:true},201)).returns[0].receivingOrderId}
 let ret=await createReturn();await completePart(fid,'RETURN_RECEIVING');
 assert.equal((await api('/comprehensive-service-orders/'+fid)).order.status,'COMPLETED');
 const charges=()=>json("select coalesce(json_agg(b),'[]') from billing_charge b join service_execution e on e.id=b.service_execution_id where e.receiving_order_id='"+ret+"'");
 assert.equal(charges().length,1);await cancel('receiving',ret,'COMPLETED');assert.equal(charges().length,0);assert.equal(stock(f.c).status,'DEPARTED');
 assert.equal((await api('/comprehensive-service-orders/'+fid)).progress.returnMissing,1);
 ret=await createReturn();await completePart(fid,'RETURN_RECEIVING');assert.equal(charges().length,1);
 const ch=charges()[0],period=new Date(ch.performed_at).toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'}).slice(0,7);
 const invoice=await api('/payment-invoices','POST',{clientId:owner,contractId:tariff.contract_id,period,chargeIds:[ch.id],requestKey:crypto.randomUUID()},201);
 const before=stock(f.c);assert.equal((await cancel('receiving',ret,'COMPLETED',409)).code,'CANCELLATION_INVOICED');assert.deepEqual(stock(f.c),before);assert.equal((await get('receiving',ret)).status,'COMPLETED');
 await api('/payment-invoices/'+invoice.invoice.id,'DELETE',undefined,204);await cancel('receiving',ret,'COMPLETED');
 assert.equal((await api('/comprehensive-service-orders/'+fid)).order.status,'CONFIRMED');
 await cancel('shipping',f.s.shippingOrders[0].id,'COMPLETED');await cancel('receiving',f.s.receivingOrder.id,'COMPLETED');
 assert.equal((await api('/comprehensive-service-orders/'+fid)).order.status,'CANCELLED');
 console.log('PASS: financial reversal, invoice guard rollback, recreate return, service completion/reopening/cancellation');
 // Return for another customer reverses both services, and paid invoices remain protected.
 const otherTariff=json("select row_to_json(t) from (select t.client_id,t.contract_id from complex_service_tariff t join complex_service_catalog c on c.id=t.complex_service_id where c.order_workflow='AUTO_RETURN' and t.active and t.client_id<>'"+owner+"' limit 1)t");
 assert.ok(otherTariff,'another client has an AUTO_RETURN tariff in the isolated snapshot');
 const g=await fixture(),gid=g.s.order.id;await completePart(gid,'INITIAL_RECEIVING');await completePart(gid,'SHIPPING');
 async function otherReturn(){return api('/comprehensive-service-orders/'+gid+'/returns','POST',{containerIds:[g.c],useCurrentClient:false,clientId:otherTariff.client_id,contractId:otherTariff.contract_id,ownerClientId:otherTariff.client_id},201)}
 const firstOther=await otherReturn();await completePart(firstOther.serviceOrderId,'RETURN_RECEIVING');const orid=firstOther.returns[0].receivingOrderId;
 assert.equal(sql("select count(*) from service_execution where receiving_order_id='"+orid+"'"),'2');
 await cancel('receiving',orid,'COMPLETED');assert.equal(stock(g.c).client_id,owner);
 assert.equal((await api('/comprehensive-service-orders/'+firstOther.serviceOrderId)).order.status,'CANCELLED');
 assert.equal((await api('/comprehensive-service-orders/'+firstOther.serviceOrderId)).progress.returnCreated,0);
 const nextOther=await otherReturn();await completePart(nextOther.serviceOrderId,'RETURN_RECEIVING');
 assert.equal((await api('/comprehensive-service-orders/'+gid)).order.status,'COMPLETED');
 const otherCharge=json("select row_to_json(b) from billing_charge b join service_execution e on e.id=b.service_execution_id where e.receiving_order_id='"+nextOther.returns[0].receivingOrderId+"' and b.client_id='"+owner+"'");
 const paid=await api('/payment-invoices','POST',{clientId:owner,contractId:tariff.contract_id,period,chargeIds:[otherCharge.id],requestKey:crypto.randomUUID()},201);
 await api('/payment-invoices/'+paid.invoice.id+'/paid','POST',{version:paid.invoice.version});
 assert.equal((await cancel('receiving',nextOther.returns[0].receivingOrderId,'COMPLETED',409)).code,'CANCELLATION_INVOICED');
 assert.equal(stock(g.c).status,'ON_TERMINAL');
 console.log('PASS: other-client return, both charges reversed, original owner restored, old service cancelled, paid invoice guarded');
 // Whole-route cancellation is atomic, including when a later order cannot be reversed.
 const q=await fixture(),z=await fixture(),qr=await manual('receiving',[q.c]),zr=await manual('receiving',[z.c]);
 const whole=await route('receiving',[qr.id,zr.id]);await confirmRoute(whole.route.id);await finish('receiving',qr.id);await finish('receiving',zr.id);
 const last=[qr,zr].sort((a,b)=>a.id.localeCompare(b.id)).at(-1);const blocked=last.id===qr.id?q.c:z.c;
 const out=await manual('shipping',[blocked]);await confirmManual('shipping',out.id);
 const routeCancel=()=>api('/routes/'+whole.route.id+'/cancellation','POST',{expectedStatus:'COMPLETED'},409);
 assert.equal((await routeCancel()).code,'CANCELLATION_STOCK_CONFLICT');
 for(const order of [qr,zr])assert.equal((await get('receiving',order.id)).status,'COMPLETED');
 await cancel('shipping',out.id,'CONFIRMED');await api('/routes/'+whole.route.id+'/cancellation','POST',{expectedStatus:'COMPLETED'});
 for(const id of [q.c,z.c]){assert.equal(stock(id).status,'DEPARTED');assert.equal(stock(id).receiving_order_id,null)}
 assert.equal((await api('/routes/'+whole.route.id)).route.status,'CANCELLED');
 console.log('PASS: whole route cancellation, full rollback on blocked member, first completed receipt reversal');
 // Concurrent duplicate cancellations leave exactly one state reversal.
 const concurrent=await manual('shipping',[a.c]);await confirmManual('shipping',concurrent.id);
 await Promise.all([cancel('shipping',concurrent.id,'CONFIRMED'),cancel('shipping',concurrent.id,'CONFIRMED')]);
 assert.equal(sql("select count(*) from container_owner_history_view where order_id='"+concurrent.id+"' and cancellation"),'1');
 assert.equal((await fetch(base+'/shipping-orders/'+concurrent.id+'/cancellation')).status,405);
 const history=await api('/containers/'+a.c+'/owner-history?includeReservations=true');assert.ok(history.some(h=>h.cancellation));
 console.log('PASS: concurrent repeated cancellation, labelled history; isolated DB='+db);
})().catch(e=>{console.error(e);process.exitCode=1});
