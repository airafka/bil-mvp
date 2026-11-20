const {assert,run,sql,json,api,clock,init}=require('./check-lib.cjs');
const stock=k=>json(`select row_to_json(o) from container_owner_current o where container_id='${k}'`);
const snapshot=()=>require('../storage-visits/ops.cjs').snapshot('billing-stock-write-db','billing_stock_write_test');
function rejected(q){let failed=false;try{sql(q)}catch(e){failed=true;}assert.ok(failed,'Expected rejection: '+q);}
(async()=>{
 const x=await init();
 // Old facts populated by migration must support cancellation, without journal reads.
 await clock(sql('select max(last_stock_at)::date from container_owner'));
 const legacy=json(`select row_to_json(t) from (select v.id,v.container_id,v.receiving_order_id,sc.shipping_order_id from container_visit v
 join container_owner o on o.container_visit_id=v.id join shipping_order_container sc on sc.id=v.shipping_order_container_id
 where not v.is_cancelled and v.reserved_recorded_at<(select installed_on from flyway_schema_history where version='60')
 and not exists(select 1 from receiving_order r where r.source_shipping_order_id=sc.shipping_order_id and r.order_status<>'CANCELLED')
 order by v.reserved_recorded_at limit 1)t`);
 assert.ok(legacy,'Restored fixture contains an old completed shipment');
 await x.cancel('shipping',legacy.shipping_order_id);assert.equal(stock(legacy.container_id).status,'ON_TERMINAL');
 assert.equal(sql(`select shipping_at is null from container_visit where id='${legacy.id}'`),'t');
 console.log('PASS cancellation of a pre-migration shipment');
 await clock('2027-02-01');const r=await x.arrival();
 const transfer=await x.create([r.ktk],x.b,'2027-02-01');
 const results=await Promise.all([1,2].map(()=>fetch('http://127.0.0.1:8306/api/service-orders/'+transfer+'/accept',{method:'POST'})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(sql(`select count(*) from container_ownership_period where service_order_id='${transfer}'`),'1');assert.equal(sql(`select count(*) from container_owner_history where order_id='${transfer}'`),'1');
 const before=snapshot();rejected(`update container_owner_history set new_status=old_status where order_id='${transfer}'`);assert.deepEqual(snapshot(),before);
 rejected(`SET ROLE stock_operation_writer;select count(*) from container_owner_history`);
 const invalid=snapshot();rejected(`update receiving_order_container set status='UPLOADED' where receiving_order_id='${r.receiving}'`);assert.deepEqual(snapshot(),invalid);
 console.log('PASS parallel confirmation, one assignment and journal record, immutable journal, completed source protection');
 // Missing composition is detected from current stock, without a reservation journal.
 const shipment=await x.ship(r.ktk,false),saved=json(`select row_to_json(sc) from shipping_order_container sc where shipping_order_id='${shipment}'`);
 sql(`delete from shipping_order_container where id='${saved.id}'`);
 const missing=await api('/shipping-orders/'+shipment+'/cancellation','POST',{expectedStatus:'CONFIRMED'},409);assert.equal(missing.code,'STOCK_VISIT_REQUIRED');assert.equal(stock(r.ktk).status,'RESERVED_OUT');
 sql(`insert into shipping_order_container select * from json_populate_record(null::shipping_order_container,'${JSON.stringify(saved).replaceAll("'","''")}')`);
 await x.cancel('shipping',shipment);
 console.log('PASS missing shipping composition blocks cancellation; restored composition cancels normally');
 // Failed audit append rolls primary writes back; there are no partial assignments or transitions.
 const failed=await x.create([r.ktk],x.c,'2027-02-02'),beforeFailure=snapshot();
 sql('REVOKE INSERT ON container_owner_history FROM stock_operation_writer');
 try{await api('/service-orders/'+failed+'/accept','POST',undefined,500);}finally{sql('GRANT INSERT ON container_owner_history TO stock_operation_writer');}
 assert.deepEqual(snapshot(),beforeFailure);await api('/service-orders/'+failed+'/accept','POST');
 // Backend downtime does not delay a dated assignment.
 run(['stop','billing-stock-write-new']);
 const old='http://127.0.0.1:8305/api/application-clock',c=await(await fetch(old)).json();
 assert.equal((await fetch(old,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:'2027-02-02',version:c.version})})).status,200);
 run(['start','billing-stock-write-new']);let healthy=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:8306/actuator/health')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(healthy);
 assert.equal(stock(r.ktk).client_id,x.c);assert.equal((await x.report(r.ktk)).items.length,3);
 await clock('2027-02-01');assert.equal(stock(r.ktk).client_id,x.b);await clock('2027-02-02');
 await x.ship(r.ktk);await clock('2027-02-01');const earlier=await x.transport('receiving',r.ktk);const beforeEarlier=snapshot();
 let rejectedEarlier=false;try{await x.confirm('receiving',earlier.id);}catch(e){assert.match(e.message,/STOCK_DATE_BEFORE_HISTORY/);rejectedEarlier=true;}assert.ok(rejectedEarlier);assert.equal(stock(r.ktk).status,'DEPARTED');
 console.log('PASS audit failure rolls back all data; backend restart and calendar select dated owner; earlier stock operations blocked');
 sql('do $$ declare r record;begin for r in select id from container_visit loop perform check_container_visit(r.id);end loop;end $$;');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
