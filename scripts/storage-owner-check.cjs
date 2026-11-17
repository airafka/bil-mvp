// Isolated databases only. Legacy migration modes compare V41/V42; lifecycle also covers V43–V49.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db=process.env.STORAGE_TEST_DB||'billing_storage_owner_test',port=db==='billing_history_operation_test'?'8208':db==='billing_storage_arrival_test'?'8207':db==='billing_storage_origin_test'?'8206':db==='billing_storage_sources_test'?'8205':db==='billing_storage_view_test'?'8204':db==='billing_stock_history_test'?'8203':'8202',base=(process.env.TEST_API_HOST||'http://127.0.0.1')+':'+port+'/api';
assert.ok(['billing_history_operation_test','billing_storage_arrival_test','billing_storage_owner_test','billing_stock_history_test','billing_storage_view_test','billing_storage_sources_test','billing_storage_origin_test'].includes(db));
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const rawSql=q=>run(['exec','billing-next-db-1','psql','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const historySchema=Number(rawSql('select max(version::int) from flyway_schema_history where success'));
const v48=historySchema>=48;
const sql=q=>{if(historySchema>=49)q=q.replaceAll('from container_owner_history ','from container_owner_history_view ').replaceAll('join container_owner_history ','join container_owner_history_view ');return rawSql(v48?q.replaceAll('receiving_history_id','start_history_id').replaceAll('shipping_history_id','end_history_id'):q);};
const json=q=>JSON.parse(sql(q)||'null',function(k,v){if(v48&&v&&typeof v==='object'&&!Array.isArray(v)){if('start_history_id' in v)v.receiving_history_id=v.start_history_id;if('end_history_id' in v)v.shipping_history_id=v.end_history_id;}return v;});
assert.equal(sql('select current_database()'),db);
const captureFile=path.join(__dirname,'../backups/storage-owner-before.json');
function snapshot(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql(`select md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),'')) from "${t}" t`)]));
 const sequences=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 const seq=Object.fromEntries(sequences.map(t=>[t,sql(`select last_value||':'||is_called from "${t}"`)]));
 const columns=json("select json_agg(t order by table_name,ordinal_position) from (select table_name,column_name,ordinal_position,data_type,is_nullable from information_schema.columns where table_schema='public')t");
 return {hashes,seq,columns};
}
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let v;try{v=JSON.parse(text)}catch{v=text}assert.equal(r.status,status,p+': '+text);return v;}
const normalized=Number(sql('select max(version::int) from flyway_schema_history where success'))>=44;
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));
const periodSource=schema>=47?"(select p.*,o.receiving_order_id,h.occurred_at receiving_at,e.occurred_at shipping_at,h.new_client_id receiving_owner_id,r.client_id receiving_client_id,r.terminal_area_catalog_id terminal_area_id,v.is_empty,v.receiving_order_container_id,v.shipping_order_container_id,v.waybill_container_id from container_storage_period p join container_storage_period_origin o on o.id=p.id join container_owner_history h on h.id=p.receiving_history_id left join container_owner_history e on e.id=p.shipping_history_id join receiving_order r on r.id=o.receiving_order_id left join container_storage_period_view v on v.id=p.id)":Number(sql('select max(version::int) from flyway_schema_history where success'))>=46?"(select p.*,h.occurred_at receiving_at,e.occurred_at shipping_at,h.new_client_id receiving_owner_id,r.client_id receiving_client_id,r.terminal_area_catalog_id terminal_area_id,v.is_empty,v.receiving_order_container_id,v.shipping_order_container_id,v.waybill_container_id from container_storage_period p join container_owner_history h on h.id=p.receiving_history_id left join container_owner_history e on e.id=p.shipping_history_id join receiving_order r on r.id=p.receiving_order_id left join container_storage_period_view v on v.id=p.id)":normalized?"(select p.*,h.occurred_at receiving_at,e.occurred_at shipping_at,h.new_client_id receiving_owner_id,r.client_id receiving_client_id,r.terminal_area_catalog_id terminal_area_id,case when p.receiving_order_container_id is not null then rc.empty else wc.net_weight=0 end is_empty from container_storage_period p join container_owner_history h on h.id=p.receiving_history_id left join container_owner_history e on e.id=p.shipping_history_id join receiving_order r on r.id=p.receiving_order_id left join receiving_order_container rc on rc.id=p.receiving_order_container_id left join waybill_container wc on wc.id=p.waybill_container_id)":'container_storage_period';
const periods=c=>json(`select coalesce(json_agg(p order by receiving_at,created_at,id),'[]') from ${periodSource} p where container_id='${c}'`);
const finish=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'},status);
const cancel=(kind,id,expectedStatus,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus,reason:'Проверка периодов собственников'},status);
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
async function main(){
 if(process.argv[2]==='capture'){
   assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'41');
   fs.mkdirSync(path.dirname(captureFile),{recursive:true});fs.writeFileSync(captureFile,JSON.stringify(snapshot()));
   console.log('PASS: captured V41 business data, sequences and all column definitions');return;
 }
 const inspect=JSON.parse(run(['inspect',db==='billing_history_operation_test'?'billing-next-history-operation-test':db==='billing_storage_arrival_test'?'billing-next-storage-arrival-test':db==='billing_storage_origin_test'?'billing-next-storage-origin-test':db==='billing_storage_sources_test'?'billing-next-storage-sources-test':db==='billing_storage_view_test'?'billing-next-storage-view-test':db==='billing_stock_history_test'?'billing-next-stock-history-test':'billing-next-storage-owner-test']))[0];
 assert.ok(inspect.Config.Env.includes('DB_NAME='+db));
 assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 assert.ok(['42','43','44','45','46','47','48','49'].includes(sql('select max(version::int) from flyway_schema_history where success')));
 if(process.argv[2]==='migration'){
   assert.deepEqual(snapshot(),JSON.parse(fs.readFileSync(captureFile,'utf8')));
   console.log('PASS: V42 preserves all business rows, sequences, table and column definitions; no retroactive splits');return;
 }
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const clients=await api('/references/clients'),owner=tariff.client_id,other=clients.filter(c=>c.id!==owner).slice(0,2).map(c=>c.id);
 assert.equal(other.length,2);const party=clients.find(c=>c.id===owner).name;
 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 async function generated(){const b=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);return {bill:b.id,container:sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${b.id}' limit 1`)};}
 async function manual(kind,c,railwayBill){return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,
   transportType:railwayBill?'RAILWAY':'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),
   arrivalAt:'2026-11-01T12:00:00',departureAt:'2026-11-01T12:00:00',consignor:party,consignee:party,
   ...(railwayBill?{waybillIds:[railwayBill]}:{containers:[{containerId:c,empty:true,ownerClientId:owner}]})},201);}
 async function confirm(kind,id,railway=false){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:railway?'RAILWAY':'VEHICLE',
   terminalAreaId:area,departureAt:'2026-11-01T12:00:00+03:00',...(railway?{}:logistics),orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});}
 async function change(c,next,status=200){const id=sql(`select id from container_owner where container_id='${c}'`);
   const o=await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',containerOwnerIds:[id]},201);
   await api('/service-orders/'+o.order.id+'/accept','POST',undefined,status);
   if(status!==200)await api('/service-orders/'+o.order.id,'DELETE',undefined,204);
   return o.order.id;}
 const report=async(id,asOf)=> (await api('/container-storage-periods?status=ALL&periodId='+id+(asOf?'&asOf='+asOf:''))).items[0];
 const history=c=>api('/containers/'+c+'/owner-history?includeReservations=true');
 // Include a real old unsplit period: it must close without rewriting its old owner snapshot.
 const legacy=json("select row_to_json(t) from (select p.*,o.client_id current_owner from "+periodSource+" p join container_owner o on o.container_id=p.container_id where p.status='OPEN' and o.client_id<>p.receiving_owner_id limit 1)t");
 if(legacy){
   await clock('2026-12-01');await change(legacy.container_id,clients.find(c=>c.id!==legacy.current_owner).id);
   const old=periods(legacy.container_id).find(p=>p.id===legacy.id);
   for(const key of ['receiving_at','receiving_history_id','receiving_owner_id','receiving_order_id','receiving_order_container_id','waybill_container_id','is_empty'])assert.deepEqual(old[key],legacy[key]);
   assert.equal(old.status,'CLOSED');console.log('PASS: first new change of a legacy unsplit period preserves its historical snapshot');
 }
 await clock('2026-11-10');const f=await generated(),c=f.container;
 let r=await manual('receiving',c);await confirm('receiving',r.id);
 // Before arrival a change only changes the register, never starts storage.
 await change(c,other[0]);assert.equal(periods(c).length,0);
 await finish('receiving',r.id);const first=periods(c)[0];assert.equal(first.receiving_owner_id,other[0]);
 await clock('2026-11-15');const transfer=await change(c,other[1]);
 let ps=periods(c),p1=ps.find(p=>p.id===first.id),p2=ps.find(p=>p.status==='OPEN');
 assert.equal(ps.length,2);assert.equal(p1.status,'CLOSED');assert.equal(p1.shipping_order_container_id,null);
 assert.equal(p1.shipping_at,p2.receiving_at);assert.equal(p1.shipping_history_id,p2.receiving_history_id);
 for(const key of ['receiving_order_id','receiving_order_container_id','waybill_container_id','is_empty','receiving_client_id','terminal_area_id'])assert.equal(p2[key],first[key]);
 assert.equal((await report(p1.id)).storageDays,5);assert.equal((await report(p2.id)).storageDays,1);
 assert.equal((await report(p1.id,'2026-11-12')).storageDays,3);
 assert.equal((await report(p1.id)).departureOperationType,'OWNER_CHANGE');assert.equal((await report(p2.id)).arrivalOperationType,'OWNER_CHANGE');
 assert.equal((await report(p1.id)).shippingOrderId,undefined);
 let h=(await history(c)).find(h=>h.orderId===transfer);assert.equal(h.storagePeriodId,p2.id);assert.equal(h.previousStoragePeriodId,p1.id);
 await api('/service-orders/'+transfer+'/accept','POST',undefined,409);assert.deepEqual(periods(c),ps);
 console.log('PASS: atomic split, exact task context, event linkage in both directions, days and asOf before transfer, retry guard');
 // Each intermediate owner on the same calendar day gets zero days.
 await change(c,owner);let p3=periods(c).find(p=>p.status==='OPEN');
 assert.equal((await report(p2.id)).storageDays,0);assert.equal((await report(p3.id)).storageDays,1);
 let s=await manual('shipping',c);await confirm('shipping',s.id);
 const frozenOwner=sql(`select owner_container_id from shipping_order_container where shipping_order_id='${s.id}'`);
 await clock('2026-11-17');await change(c,other[0]);let p4=periods(c).find(p=>p.status==='OPEN');
 assert.equal(sql(`select status from container_owner where container_id='${c}'`),'RESERVED_OUT');
 assert.equal(sql(`select owner_container_id from shipping_order_container where shipping_order_id='${s.id}'`),frozenOwner);
 await clock('2026-11-20');await finish('shipping',s.id);assert.equal((await report(p4.id)).storageDays,4);
 assert.equal((await report(p3.id)).storageDays,2);
 assert.equal((await report(p4.id)).departureOperationType,'DEPARTURE');assert.equal((await report(p4.id)).shippingOrderId,s.id);
 const sum=(await Promise.all(periods(c).map(p=>report(p.id)))).reduce((n,p)=>n+p.storageDays,0);assert.equal(sum,11);
 await cancel('shipping',s.id,'COMPLETED');assert.equal(periods(c).find(p=>p.id===p4.id).status,'OPEN');
 s=await manual('shipping',c);await confirm('shipping',s.id);await cancel('shipping',s.id,'CONFIRMED');assert.equal(periods(c).find(p=>p.id===p4.id).status,'OPEN');
 const beforeBackdate=periods(c);await clock('2026-11-16');await change(c,other[1],409);assert.deepEqual(periods(c),beforeBackdate);
 await clock('2026-11-21');await cancel('receiving',r.id,'COMPLETED');
 assert.ok(periods(c).every(p=>p.status==='CANCELLED'));if(normalized)assert.equal(await report(first.id),undefined);else assert.equal((await report(first.id)).storageDays,undefined);
 console.log('PASS: multiple same-day changes, reserved stock, frozen shipment owner, departure/cancellation, chronological guard, whole-visit annulment');
 // Cancellation retains the owner boundaries. Re-arrival creates an independent root.
 r=await manual('receiving',c);await confirm('receiving',r.id);await finish('receiving',r.id);
 const newRoot=periods(c).find(p=>p.status==='OPEN');assert.notEqual(newRoot.id,first.id);
 assert.equal((await report(newRoot.id)).arrivalOperationType,'ARRIVAL');
 s=await manual('shipping',c);await confirm('shipping',s.id);await finish('shipping',s.id);
 const closedBefore=periods(c);await change(c,other[0]);assert.deepEqual(periods(c),closedBefore);
 await cancel('shipping',s.id,'COMPLETED',409);assert.deepEqual(periods(c),closedBefore);
 console.log('PASS: independent repeat visit, no storage for departed KTK, blocked reopening after an off-site owner change');
 // Railway source survives split and reuse of a waybill after annulment.
 const rail=await generated();const rr=await manual('receiving',rail.container,rail.bill);await confirm('receiving',rr.id,true);await finish('receiving',rr.id);
 const railFirst=periods(rail.container)[0];assert.ok(railFirst.waybill_container_id);
 await change(rail.container,other[0]);const railNext=periods(rail.container).find(p=>p.status==='OPEN');
 assert.equal(railNext.waybill_container_id,railFirst.waybill_container_id);assert.equal(railNext.receiving_order_container_id,null);
 assert.equal((await report(railNext.id)).cargoName,(await report(railFirst.id)).cargoName);
 // Enforced by the DB even when a write bypasses the application.
 function rejected(q){let failed=false;try{sql('begin; '+q+'; set constraints all immediate; rollback;')}catch(e){failed=true;assert.match(String(e.stderr),/Invalid storage|requires its exact|does not match|violates (check|foreign key) constraint|duplicate key/);}assert.ok(failed,'Invalid write was accepted');}
 rejected(`update container_storage_period set shipping_history_id=receiving_history_id,${normalized?'':'shipping_at=receiving_at,'}status='CLOSED' where id='${railNext.id}'`);
 rejected(normalized?`update container_owner_history set new_client_id='${other[1]}' where id='${railNext.receiving_history_id}'`:`update container_storage_period set receiving_owner_id='${other[1]}' where id='${railNext.id}'`);
 rejected(historySchema>=49?`update container_owner_history set old_status='RESERVED_OUT',new_status='DEPARTED',order_type='SHIPPING_ORDER' where id='${railNext.receiving_history_id}'`:`update container_owner_history set operation_type='DEPARTURE' where id='${railNext.receiving_history_id}'`);
 rejected(normalized?`update container_owner_history set occurred_at=occurred_at+interval '1 day' where id='${railNext.receiving_history_id}'`:`update container_storage_period set receiving_at=receiving_at+interval '1 day' where id='${railNext.id}'`);
 rejected(`delete from container_storage_period where id='${railFirst.id}'`);
 // One invalid row must roll back owner changes already attempted for other KTK.
 await clock('2026-11-22');const second=await generated();const secondReceipt=await manual('receiving',second.container);
 await confirm('receiving',secondReceipt.id);await finish('receiving',secondReceipt.id);
 await clock('2026-11-21');const originals=[periods(rail.container),periods(second.container)];
 const ownerIds=[rail.container,second.container].map(id=>sql(`select id from container_owner where container_id='${id}'`));
 const batch=await api('/service-orders','POST',{clientId:other[1],service:'CHANGE_OWNER',containerOwnerIds:ownerIds},201);
 await api('/service-orders/'+batch.order.id+'/accept','POST',undefined,409);
 assert.deepEqual([periods(rail.container),periods(second.container)],originals);
 assert.equal(sql(`select count(*) from container_owner_history where order_id='${batch.order.id}'`),'0');
 assert.equal(sql(`select client_id from container_owner where container_id='${rail.container}'`),other[0]);
 await api('/service-orders/'+batch.order.id,'DELETE',undefined,204);
 await clock('2026-11-22');
 // Concurrent repeats serialize on the ownership order and cannot split twice.
 const once=await api('/service-orders','POST',{clientId:other[0],service:'CHANGE_OWNER',containerOwnerIds:[ownerIds[1]]},201);
 const repeated=await Promise.all([1,2].map(()=>fetch(base+'/service-orders/'+once.order.id+'/accept',{method:'POST'}).then(r=>r.status)));
 assert.deepEqual(repeated.sort(),[200,409]);assert.equal(periods(second.container).length,2);
 // Keep this valid open chain for UI verification.
 const csv=await fetch(base+'/container-storage-periods/export?query='+encodeURIComponent((await report(railNext.id)).containerName));
 const bytes=new Uint8Array(await csv.arrayBuffer());assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);const csvText=new TextDecoder().decode(bytes);
 assert.match(csvText,/Начало периода/);assert.match(csvText,/Основание окончания/);assert.match(csvText,/Смена собственника/);assert.doesNotMatch(csvText,/Вывезен/);
 fs.writeFileSync(path.join(__dirname,'../backups/storage-owner-fixtures.json'),JSON.stringify({db,containerId:rail.container,periodId:railNext.id,previousPeriodId:railFirst.id,receivingId:rr.id,waybillId:rail.bill}));
 console.log('PASS: railway exact source and cargo, database boundary/owner integrity, batch rollback, concurrent repeat, CSV and UI fixture');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
