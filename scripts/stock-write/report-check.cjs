// V60: run only on the guarded disposable copy, with V59 on 8305 and V60 on 8306.
const {assert,sql,json,api,clock,init}=require('./check-lib.cjs');
const {snapshot}=require('../storage-visits/ops.cjs');
const code=k=>sql(`select code from container where id='${k}'`);
async function text(port,suffix){const r=await fetch(`http://127.0.0.1:${port}/api/container-storage-periods${suffix}`);return {status:r.status,body:await r.text()};}
let comparisons=0;
async function compare(suffixes){for(const suffix of suffixes){assert.deepEqual(await text(8306,suffix),await text(8305,suffix),suffix);comparisons++;}}
const suffixes=['?size=100','?status=ALL&size=100','?status=CLOSED','?status=OPEN','?status=CANCELLED','/visits?size=100','/containers','/export','/export?status=CLOSED','?query=NO_SUCH_CONTAINER','?status=WRONG','?arrivalFrom=2026-09-20&arrivalTo=2026-09-15'];
// Compare error status only: Spring problem responses include request-specific metadata.
suffixes.splice(-2);
async function checkContainer(k){const q='query='+code(k);await compare(['?size=100&'+q,'/visits?size=1&'+q,'/visits?size=1&page=1&'+q,'/export?'+q]);}
(async()=>{
 const x=await init();
 await compare(suffixes);
 await clock('2026-09-15');const r=await x.arrival();
 await x.schedule([r.ktk],x.b,'2026-09-17');
 let rows=(await x.report(r.ktk)).items;assert.equal(rows.length,1);assert.ok(rows[0].departureAt == null);
 await checkContainer(r.ktk);await clock('2026-09-20');const shipping=await x.ship(r.ktk);
 rows=(await x.report(r.ktk)).items;assert.deepEqual(rows.map(r=>r.storageDays).sort(),[2,4]);
 await checkContainer(r.ktk);
 const visit=(await api('/container-storage-periods/visits?query='+code(r.ktk))).items[0];assert.equal(visit.storageDays,6);assert.equal(visit.periods.length,2);
 for(const p of visit.periods)await compare(['?periodId='+p.id,'/visits?periodId='+p.id,'/export?periodId='+p.id]);
 for(const day of ['2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-20'])await compare(['?asOf='+day,'/visits?asOf='+day,'/export?asOf='+day]);
 await compare(['?clientId='+x.a,'/export?clientId='+x.a,'?arrivalFrom=2026-09-17&arrivalTo=2026-09-20','/export?arrivalFrom=2026-09-17&arrivalTo=2026-09-20']);
 console.log('PASS receiving15 / transfer17 / shipping20 = 2+4; future hidden, dates, filters, deep links, CSV');
 await x.cancel('shipping',shipping);assert.equal(sql(`select shipping_at is null from container_visit where id='${visit.id}'`),'t');await checkContainer(r.ktk);
 const shipping2=await x.ship(r.ktk);await clock('2026-09-21');const repeat=await x.arrival(r.ktk,x.a);await checkContainer(r.ktk);
 assert.equal((await api('/container-storage-periods/visits?query='+code(r.ktk))).totalElements,2);
 await x.cancel('receiving',repeat.receiving);await x.cancel('shipping',shipping2);await checkContainer(r.ktk);
 await x.cancel('receiving',r.receiving);assert.equal((await x.report(r.ktk)).items.length,0);await checkContainer(r.ktk);
 console.log('PASS shipping cancellation/re-shipping, repeated receiving and reversal, cancelled visit excluded');
 await clock('2026-09-16');const back=await x.arrival();await clock('2026-09-20');await x.schedule([back.ktk],x.b,'2026-09-18');await x.schedule([back.ktk],x.c,'2026-09-17');
 assert.deepEqual((await x.report(back.ktk)).items.map(r=>r.storageDays).sort(),[1,1,3]);await checkContainer(back.ktk);
 for(const day of ['2026-09-16','2026-09-17','2026-09-18','2026-09-20']){await clock(day);await checkContainer(back.ktk);}
 const planned=await x.schedule([back.ktk],x.a,'2026-09-23');await api('/service-orders/'+planned+'/withdraw','POST');
 await api('/service-orders/'+planned,'PUT',{id:planned,service:'CHANGE_OWNER',effectiveDate:'2026-09-24'});await api('/service-orders/'+planned+'/accept','POST');await checkContainer(back.ktk);
 await clock('2026-09-23');assert.equal((await x.report(back.ktk)).items.length,3);await clock('2026-09-24');assert.equal((await x.report(back.ktk)).items.length,4);await checkContainer(back.ktk);await clock('2026-09-20');await checkContainer(back.ktk);
 console.log('PASS backdated insertion, calendar forward/backward, withdrawn/reconfirmed future transfer');
 const same=await x.arrival();await x.schedule([same.ktk],x.b,'2026-09-20');await x.schedule([same.ktk],x.c,'2026-09-20');
 assert.deepEqual((await x.report(same.ktk)).items.map(r=>r.storageDays).sort(),[0,0,1]);await checkContainer(same.ktk);
 const early=await x.arrival();await x.schedule([early.ktk],x.b,'2026-09-23');await x.ship(early.ktk);await clock('2026-09-24');assert.equal((await x.report(early.ktk)).items.length,1);await checkContainer(early.ktk);
 const expected=await x.arrival(undefined,x.a,false);assert.equal((await x.report(expected.ktk)).items.length,0);await checkContainer(expected.ktk);await x.cancel('receiving',expected.receiving);
 const long=await x.arrival();for(let i=0;i<24;i++)await x.schedule([long.ktk],i%2?x.a:x.b,'2026-09-24');await checkContainer(long.ktk);assert.equal((await api('/container-storage-periods/visits?query='+code(long.ktk))).items[0].periods.length,25);
 console.log('PASS same-day zero-day assignments; shipping before future transfer; expected/cancelled reservation; 25 assignments in one visit');
 // Railway source and cargo: use generated waybill directly, without a cancellation archive.
 const service=(await api('/comprehensive-service-orders/available-services'))[0];
 const tariff=json(`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='${service.id}' and active order by id limit 1)t`);
 const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);
 const rail=await api('/comprehensive-service-orders','POST',{complexServiceId:service.id,clientId:tariff.client_id,contractId:tariff.contract_id,defaultContainerOwnerId:tariff.client_id,waybillIds:[bill.id]},201);
 const rid=rail.order.id;await api('/comprehensive-service-orders/'+rid+'/prepare-transport','POST',{section:'INITIAL_RECEIVING'});
 for(const action of ['CONFIRM_ROUTES','COMPLETE_ORDERS'])await api('/comprehensive-service-orders/'+rid+'/complete-section','POST',{section:'INITIAL_RECEIVING',action});
 await checkContainer(rail.receivingOrder.containers[0].containerId);
 const before=snapshot('billing-stock-write-db','billing_stock_write_test');await compare(suffixes);assert.deepEqual(snapshot('billing-stock-write-db','billing_stock_write_test'),before);
 sql('do $$ declare r record;begin for r in select id from container_visit loop perform check_container_visit(r.id);end loop;end $$;');
 assert.equal(sql("select count(*) from container_ownership_period p join container_owner_history h on h.id=p.start_container_owner_history_id where p.effective_at<>h.occurred_at or p.recorded_at<>h.created_at or p.service_order_id is distinct from case when h.order_type='SERVICE_ORDER' then h.order_id end"),'0');
 console.log('PASS railway/cargo; immutable report reads; existing visit integrity; '+comparisons+' V59/V60 response comparisons');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
