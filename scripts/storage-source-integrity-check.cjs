// Destructive source-integrity scenarios are restricted to a dedicated restored test database.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const db=process.env.STORAGE_TEST_DB||'billing_storage_sources_test',docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024}).trim();
const json=q=>JSON.parse(sql(q)||'null');
assert.ok(['billing_history_cancellation_test','billing_history_metadata_test','billing_history_operation_test','billing_storage_arrival_test','billing_storage_sources_test','billing_storage_origin_test'].includes(db));
assert.equal(sql('select current_database()'),db);
const schema=Number(sql('select max(version::int) from flyway_schema_history where success'));assert.ok([46,47,48,49,50,51].includes(schema));
const port=db==='billing_history_cancellation_test'?'8210':db==='billing_history_metadata_test'?'8209':db==='billing_history_operation_test'?'8208':db==='billing_storage_arrival_test'?'8207':db==='billing_storage_origin_test'?'8206':'8205',receivingRef=schema>=47?'storage_receiving_order(id)':'receiving_order_id';
const inspect=JSON.parse(execFileSync(docker,['inspect',db==='billing_history_cancellation_test'?'billing-next-history-cancellation-test':db==='billing_history_metadata_test'?'billing-next-history-metadata-test':db==='billing_history_operation_test'?'billing-next-history-operation-test':db==='billing_storage_arrival_test'?'billing-next-storage-arrival-test':db==='billing_storage_origin_test'?'billing-next-storage-origin-test':'billing-next-storage-sources-test'],{encoding:'utf8'}))[0];
assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
const base=(process.env.TEST_API_HOST||'http://127.0.0.1')+':'+port+'/api';
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
function rejected(q){let failed=false;try{sql('BEGIN; '+q+'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;');}catch(e){failed=true;assert.match(String(e.stderr),/Invalid storage.*source|requires its exact|violates.*constraint/);}assert.ok(failed,'Invalid write accepted: '+q);}
(async()=>{
 const fixture=JSON.parse(fs.readFileSync('backups/storage-owner-fixtures.json','utf8'));assert.equal(fixture.db,db);
 const auto=json("select row_to_json(v) from container_storage_period_view v where receiving_order_container_id is not null limit 1");
 const ship=json("select row_to_json(v) from container_storage_period_view v where shipping_order_container_id is not null limit 1");
 const rail=json("select row_to_json(v) from container_storage_period_view v where id='"+fixture.periodId+"'");
 assert.ok(auto&&ship&&rail);
 const unrelated=sql("select id from container where id<>'"+auto.container_id+"' and id<>'"+ship.container_id+"' limit 1");
 rejected("update receiving_order_container set container_id='"+unrelated+"' where id='"+auto.receiving_order_container_id+"'");
 rejected("update receiving_order_container set status=null where id='"+auto.receiving_order_container_id+"'");
 rejected("update receiving_order set order_status='CANCELLED' where id='"+auto.receiving_order_id+"'");
 rejected("update shipping_order_container set status=null where id='"+ship.shipping_order_container_id+"'");
 rejected("update shipping_order_container set container_id='"+unrelated+"' where id='"+ship.shipping_order_container_id+"'");
 rejected("update shipping_order set order_status='CANCELLED' where id='"+ship.shipping_order_id+"'");
 rejected("update waybill set receiving_order_id=null where id='"+fixture.waybillId+"'");
 rejected("update waybill_container set status=null where id='"+rail.waybill_container_id+"'");
 rejected("insert into waybill_container select (jsonb_populate_record(null::waybill_container,to_jsonb(wc)||jsonb_build_object('id',gen_random_uuid()))).* from waybill_container wc where id='"+rail.waybill_container_id+"'");
 const carriage=sql("select waybill_railway_carriage_id from waybill_container where id='"+rail.waybill_container_id+"'");
 const otherCarriage=sql("select wr.id from waybill_railway_carriage wr join waybill w on w.id=wr.waybill_id where w.receiving_order_id is null and wr.id<>'"+carriage+"' limit 1");
 assert.ok(otherCarriage);
 rejected("update waybill_container set waybill_railway_carriage_id='"+otherCarriage+"' where id='"+rail.waybill_container_id+"'");
 rejected("update waybill_railway_carriage set waybill_id=(select waybill_id from waybill_railway_carriage where id='"+otherCarriage+"') where id='"+carriage+"'");
 console.log('PASS: missing/wrong/duplicate auto, shipping and railway sources rejected by DB, including document and carriage changes');

 const original=await api('/receiving-orders/'+fixture.receivingId);
 await api('/receiving-orders/'+fixture.receivingId+'/cancellation','POST',{expectedStatus:'COMPLETED',reason:'V46: повторное использование накладной'});
 assert.equal(sql("select count(*) from container_storage_period_view where receiving_order_id='"+fixture.receivingId+"'"),'0');
 assert.equal(sql("select receiving_order_id is null from waybill where id='"+fixture.waybillId+"'"),'t');
 assert.ok(Number(sql("select count(*) from container_storage_period where "+receivingRef+"='"+fixture.receivingId+"' and status='CANCELLED'"))>=2);
 sql("update waybill_container set net_weight=0 where id='"+rail.waybill_container_id+"'");
 const r=await api('/receiving-orders','POST',{clientId:original.clientId,contractId:original.contractId,terminalAreaId:original.terminalArea.id,
 transportType:'RAILWAY',fillingType:'ALL',defaultContainerOwnerId:original.clientId,consignor:original.clientName,
 arrivalAt:'2026-11-22T12:00:00',waybillIds:[fixture.waybillId]},201);
 const route=await api('/routes','POST',{routeType:'RECEIVING',transportType:'RAILWAY',terminalAreaId:original.terminalArea.id,
 departureAt:'2026-11-22T12:00:00+03:00',orderIds:[r.id]},201);
 await api('/routes/'+route.route.id+'/confirm','POST',{});
 await api('/receiving-orders/'+r.id+'/events','POST',{eventCode:'UNLOAD_FINISH'});
 const now=json("select row_to_json(v) from container_storage_period_view v where receiving_order_id='"+r.id+"'");
 assert.ok(now);assert.equal(now.container_id,rail.container_id);assert.equal(now.waybill_container_id,rail.waybill_container_id);assert.equal(now.is_empty,true);
 assert.notEqual(now.id,rail.id);assert.equal(sql("select count(*) from container_storage_period_view where receiving_order_id='"+fixture.receivingId+"'"),'0');
 assert.equal((await api('/container-storage-periods?status=ALL&periodId='+rail.id)).totalElements,0);
 const reused=(await api('/container-storage-periods?periodId='+now.id)).items[0];assert.equal(reused.empty,true);assert.equal(reused.receivingOrderId,r.id);
 const csv=await(await fetch(base+'/container-storage-periods/export?status=ALL&periodId='+rail.id)).text();assert.equal(csv.trim().split('\r\n').length,1);
 console.log('PASS: whole cancelled chain hidden; released waybill edited and reused by a new receipt without affecting old periods');
})().catch(e=>{console.error(e);process.exitCode=1;});
