// Mutating integration checks. Refuses any database/backend other than this isolated fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db=process.env.STORAGE_TEST_DB||'billing_container_tasks_test';
assert.ok(['billing_container_tasks_test','billing_storage_fields_test','billing_history_fields_test','billing_storage_owner_test','billing_stock_history_test'].includes(db));
const stockTest=db==='billing_stock_history_test',ownerTest=db==='billing_storage_owner_test',historyTest=db==='billing_history_fields_test',fieldsTest=db==='billing_storage_fields_test',port=stockTest?'8203':ownerTest?'8202':historyTest?'8201':fieldsTest?'8198':'8194',base='http://127.0.0.1:'+port+'/api';
const inspect=JSON.parse(execFileSync(docker,['inspect',stockTest?'billing-next-stock-history-test':ownerTest?'billing-next-storage-owner-test':historyTest?'billing-next-history-fields-test':fieldsTest?'billing-next-storage-fields-test':'billing-next-container-tasks-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(inspect.Config.Env.includes('DB_NAME='+db));
assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();
assert.equal(sql('select current_database()'),db);
const json=q=>JSON.parse(sql(q));
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();let v;try{v=JSON.parse(t)}catch{v=t}assert.equal(r.status,status,p+': '+t);return v}
const cancel=(kind,id,expectedStatus,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus,reason:'Проверка истории хранения'},status);
const finish=(kind,id)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});
const periods=c=>json(`select coalesce(json_agg(p order by created_at,id),'[]') from container_storage_period p where container_id='${c}'`);
const taskStatus=(kind,id)=>json(`select json_build_object('status',status) from ${kind}_order_container where ${kind}_order_id='${id}'`).status;
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
 let r=await manual('receiving');assert.equal(taskStatus('receiving',r.id),null);await confirm('receiving',r.id);assert.equal(taskStatus('receiving',r.id),'UPLOADED');assert.equal(periods(c).length,0);
 await cancel('receiving',r.id,'CONFIRMED');assert.equal(taskStatus('receiving',r.id),null);assert.equal(periods(c).length,0);
 assert.ok((await history(c)).some(h=>h.operationType==='CANCEL_RECEIVING_RESERVATION'&&h.orderId===r.id&&h.oldStatus==='EXPECTED'&&h.newStatus==='DEPARTED'&&h.cancellation&&!h.storagePeriodId));
 r=await manual('receiving');await confirm('receiving',r.id);await finish('receiving',r.id);
 assert.equal(taskStatus('receiving',r.id),'FINISHED');
 let p=periods(c)[0];assert.equal(p.receiving_order_container_id,sql(`select id from receiving_order_container where receiving_order_id='${r.id}'`));assert.equal(p.waybill_container_id,null);
 sql(`do $$ begin begin update receiving_order_container set status='CANCELED' where receiving_order_id='${r.id}'; raise exception 'Unexpected status accepted'; exception when check_violation then null; end; end $$`);assert.equal(p.status,'OPEN');assert.equal(p.is_empty,true);assert.equal(p.receiving_order_id,r.id);
 const hid=p.receiving_history_id,pid=p.id,arrival=p.receiving_at;
 let h=(await history(c)).find(h=>h.id===hid);assert.equal(h.storagePeriodId,pid);assert.equal(h.operationType,'ARRIVAL');
 assert.equal(h.timeSource,'MANUAL_COMPLETION');assert.ok(h.occurredAt);
 await finish('receiving',r.id);assert.equal(periods(c).length,1);assert.equal((await history(c)).filter(h=>h.operationType==='ARRIVAL').length,1);
 let s=await manual('shipping');await confirm('shipping',s.id);assert.deepEqual(periods(c)[0],p);
 await cancel('shipping',s.id,'CONFIRMED');assert.deepEqual(periods(c)[0],p);
 assert.ok((await history(c)).some(h=>h.operationType==='CANCEL_SHIPPING_RESERVATION'&&h.orderId===s.id&&h.oldStatus==='RESERVED_OUT'&&h.newStatus==='ON_TERMINAL'&&h.cancellation&&h.storagePeriodId===pid));
 console.log('PASS: reservations never start/stop storage; arrival links and repeated completion');
 s=await manual('shipping');await confirm('shipping',s.id);await finish('shipping',s.id);p=periods(c)[0];
 assert.equal(taskStatus('shipping',s.id),'FINISHED');assert.equal(p.shipping_order_container_id,sql(`select id from shipping_order_container where shipping_order_id='${s.id}'`));assert.equal(p.status,'CLOSED');assert.equal(sql(`select shipping_order_id from shipping_order_container where id='${p.shipping_order_container_id}'`),s.id);assert.equal((await api('/container-storage-periods?periodId='+p.id)).items[0].shippingOrderId,s.id);assert.ok(p.shipping_history_id);const dh=p.shipping_history_id;
 await Promise.all([finish('shipping',s.id),finish('shipping',s.id)]);assert.deepEqual(periods(c)[0],p);
 let report=await api('/container-storage-periods?periodId='+pid);assert.equal(report.items[0].storageDays,1);assert.equal(report.items[0].inStock,false);
 await Promise.all([cancel('shipping',s.id,'COMPLETED'),cancel('shipping',s.id,'COMPLETED')]);p=periods(c)[0];
 assert.equal(p.id,pid);assert.equal(p.receiving_at,arrival);assert.equal(p.status,'OPEN');assert.equal(p.shipping_at,null);
 assert.equal(taskStatus('shipping',s.id),null);assert.equal(p.shipping_order_container_id,null);assert.ok(!('shipping_order_id' in p));assert.equal((await api('/container-storage-periods?periodId='+p.id)).items[0].shippingOrderId,undefined);assert.equal(p.shipping_history_id,null);for(const field of ['version','needs_review','review_reason'])assert.ok(!(field in p));
 h=(await history(c)).filter(h=>h.operationType==='CANCEL_DEPARTURE');assert.equal(h.length,1);assert.equal(h[0].orderId,s.id);assert.equal(h[0].oldStatus,'DEPARTED');assert.equal(h[0].newStatus,'ON_TERMINAL');assert.equal(h[0].cancellation,true);
 assert.equal(h[0].storagePeriodId,pid);assert.equal((await api('/shipping-orders/'+s.id+'/cancellation')).reason,'Проверка истории хранения');
 for(const field of ['targetHistoryId','sourceSystem','sourceOperationKey','reason','needsReview','reviewReason'])assert.ok(!(field in h[0]));
 assert.ok((await history(c)).find(h=>h.id===dh&&!h.cancellation));
 assert.equal(sql(`select count(*) from container_movement m where m.container_id='${c}' and not exists(select 1 from container_owner_history h where h.container_id=m.container_id and h.order_id=m.order_id and h.operation_type=case when m.event_code='LOAD_FINISH' then 'DEPARTURE' else 'ARRIVAL' end and h.occurred_at at time zone 'UTC'=m.event_date_time)`),'0');
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
 await cancel('receiving',r.id,'COMPLETED');assert.equal(periods(c)[0].status,'CANCELLED');assert.equal(taskStatus('receiving',r.id),null);
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
 assert.equal(sql(`select count(*) from container_storage_period where status='OPEN' and shipping_at is not null`),'0');
 fs.mkdirSync(path.join(__dirname,'../backups'),{recursive:true});
 fs.writeFileSync(path.join(__dirname,'../backups/'+(fieldsTest?'storage-fields-task-fixtures.json':'container-task-fixtures.json')),JSON.stringify({db,containerId:c,periodId:pid}));
 console.log('PASS: filter validation, CSV export, bidirectional history consistency');
 // Railway task rows retain their identity when a cancelled waybill is reused.
 const generated=await api('/waybills/generate','POST',{standard20:2,standard40:0},201);
 const catalog=(await api('/comprehensive-service-orders/available-services'))[0];
 const pair=json(`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active and complex_service_id='${catalog.id}' order by id limit 1)t`);
 const createRail=()=>api('/comprehensive-service-orders','POST',{complexServiceId:catalog.id,clientId:pair.client_id,contractId:pair.contract_id,defaultContainerOwnerId:pair.client_id,waybillIds:[generated.id]},201);
 const prep=(id,section)=>api('/comprehensive-service-orders/'+id+'/prepare-transport','POST',{section});
 const act=(id,section,action,status=200)=>api('/comprehensive-service-orders/'+id+'/complete-section','POST',{section,action},status);
 const railRows=()=>json(`select json_agg(wc order by wc.container_id) from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${generated.id}'`);
 let rail=await createRail(),rid=rail.receivingOrder.id,sid=rail.order.id;
 assert.ok(railRows().every(x=>x.status===null));
 await prep(sid,'INITIAL_RECEIVING');await act(sid,'INITIAL_RECEIVING','CONFIRM_ROUTES');
 assert.ok(railRows().every(x=>x.status==='UPLOADED'));
 const lines=railRows(),broken=lines.at(-1);
 sql(`update waybill_container set status=null where id='${broken.id}'`);
 await act(sid,'INITIAL_RECEIVING','COMPLETE_ORDERS',409);
 assert.equal(sql(`select count(*) from container_storage_period where receiving_order_id='${rid}'`),'0');
 assert.equal(sql(`select count(*) from container_owner where receiving_order_id='${rid}' and status<>'EXPECTED'`),'0');
 assert.equal(railRows()[0].status,'UPLOADED');
 sql(`update waybill_container set status='UPLOADED' where id='${broken.id}'`);
 await act(sid,'INITIAL_RECEIVING','COMPLETE_ORDERS');
 assert.ok(railRows().every(x=>x.status==='FINISHED'));
 const firstPeriods=json(`select json_agg(p order by container_id) from container_storage_period p where receiving_order_id='${rid}'`);
 assert.equal(firstPeriods.length,2);
 for(const p of firstPeriods){assert.equal(p.waybill_container_id,lines.find(x=>x.container_id===p.container_id).id);assert.equal(p.receiving_order_container_id,null);assert.equal(p.shipping_order_container_id,null);}
 // Composite keys reject a source belonging to another physical container.
 sql(`do $$ begin begin update container_storage_period set waybill_container_id='${lines[1].id}' where id='${firstPeriods[0].id}'; raise exception 'Cross-container source accepted'; exception when foreign_key_violation then null; end; end $$`);
 const returned=(await api('/container-storage-periods?periodId='+firstPeriods[0].id)).items[0];assert.equal(returned.waybillContainerId,firstPeriods[0].waybill_container_id);
 await api('/comprehensive-service-orders/'+sid+'/no-return','POST',{containerIds:lines.map(x=>x.container_id)});
 await prep(sid,'SHIPPING');await act(sid,'SHIPPING','CONFIRM_ROUTES');
 assert.equal(sql(`select count(*) from shipping_order_container sc join shipping_order s on s.id=sc.shipping_order_id where s.comprehensive_service_order_id='${sid}' and sc.status='UPLOADED'`),'2');
 await act(sid,'SHIPPING','COMPLETE_ORDERS');
 assert.equal(sql(`select count(*) from container_storage_period p join shipping_order_container sc on sc.id=p.shipping_order_container_id where p.receiving_order_id='${rid}' and sc.status='FINISHED' and p.status='CLOSED' and sc.container_id=p.container_id`),'2');
 assert.equal(sql(`select count(*) from billing_charge b join service_execution e on e.id=b.service_execution_id where e.comprehensive_service_order_id='${sid}'`),'2');
 for(const sh of rail.shippingOrders){await cancel('shipping',sh.id,'COMPLETED');assert.equal(taskStatus('shipping',sh.id),null);}
 assert.equal(sql(`select count(*) from container_storage_period where receiving_order_id='${rid}' and status='OPEN' and shipping_order_container_id is null`),'2');
 await cancel('receiving',rid,'COMPLETED');
 assert.ok(railRows().every(x=>x.status===null));
 const cancelled=json(`select json_agg(p order by container_id) from container_storage_period p where receiving_order_id='${rid}'`);
 assert.ok(cancelled.every(p=>p.status==='CANCELLED'&&p.waybill_container_id));
 assert.equal(sql(`select receiving_order_id is null from waybill where id='${generated.id}'`),'t');
 rail=await createRail();await prep(rail.order.id,'INITIAL_RECEIVING');await act(rail.order.id,'INITIAL_RECEIVING','CONFIRM_ROUTES');await act(rail.order.id,'INITIAL_RECEIVING','COMPLETE_ORDERS');
 assert.deepEqual(json(`select json_agg(p order by container_id) from container_storage_period p where receiving_order_id='${rid}'`),cancelled);
 assert.equal(sql(`select count(*) from container_storage_period where receiving_order_id='${rail.receivingOrder.id}' and waybill_container_id in ('${lines[0].id}','${lines[1].id}') and status='OPEN'`),'2');
 console.log('PASS: railway row statuses, exact sources, cross-container FK, atomic rollback, billing, cancellation and waybill reuse');

})().catch(e=>{console.error(e);process.exitCode=1});
