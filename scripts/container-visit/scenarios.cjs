const {assert,run,sql,json,fs,api,clock,pause,init,capture}=require('./check-lib.cjs');
const fixture=JSON.parse(fs.readFileSync('fixture.json'));
const owner=k=>sql(`select client_id from container_owner_current where container_id='${k}'`);
const visit=k=>sql(`select container_visit_id from container_owner where container_id='${k}'`);
const countHistory=id=>Number(sql(`select count(*) from container_owner_history where order_id='${id}'`));
const row=id=>json(`select row_to_json(s) from service_order_container s where service_order_id='${id}' limit 1`);
(async()=>{
 const x=await init('billing-visit-check-new');assert.equal(sql('select max(version::int) from flyway_schema_history'),'55');
 assert.deepEqual(await capture(),JSON.parse(fs.readFileSync('before-report.json')));
 assert.deepEqual(json('select json_agg(h order by id) from container_owner_history h'),JSON.parse(fs.readFileSync('before-history.json')));
 assert.equal(sql("select count(*) from information_schema.columns where table_name='container_owner' and column_name in ('client_id','receiving_order_id')"),'0');
 assert.equal(owner(fixture.expected.ktk),x.b);assert.equal(owner(fixture.future.ktk),x.a);
 assert.equal(row(fixture.scheduled).container_visit_id,visit(fixture.future.ktk));
 console.log('PASS V54→V55: exact API report/CSV/history; EXPECTED owner, cancellations, scheduled visit and owner retained');
 await x.finish('receiving',fixture.expected.receiving);assert.equal(owner(fixture.expected.ktk),x.b);
 const k=fixture.future.ktk;const firstVisit=visit(k);
 await clock('2026-09-16');assert.equal(owner(k),x.a);assert.equal(countHistory(fixture.scheduled),0);
 await clock('2026-09-17');await x.waitStatus(fixture.scheduled);assert.equal(owner(k),x.b);assert.equal(countHistory(fixture.scheduled),1);
 assert.equal(sql(`select occurred_at at time zone 'Europe/Moscow' from container_owner_history where order_id='${fixture.scheduled}'`),'2026-09-17 00:00:00');
 await clock('2026-09-16');assert.equal(owner(k),x.b);
 const backwards=await x.create([k],x.c,'2026-09-16');await api('/service-orders/'+backwards+'/accept','POST',undefined,409);await api('/service-orders/'+backwards,'DELETE',undefined,204);
 await clock('2026-09-20');const shipping=await x.ship(k);
 let report=(await x.report(k)).items;assert.deepEqual(report.map(r=>r.storageDays).sort((a,b)=>a-b),[2,4]);assert.equal(visit(k),firstVisit);
 const csv=await (await fetch('http://127.0.0.1:8235/api/container-storage-periods/export?query='+sql(`select code from container where id='${k}'`))).text();assert.equal(csv.split('\n')[0].split(';').length,17);
 console.log('PASS receiving 15 / transfer 17 / shipping 20: A=2 B=4; future, Moscow midnight, clock rollback, 17-column CSV');
 await x.cancel('shipping',shipping);assert.equal(owner(k),x.b);assert.equal(sql(`select shipping_date from container_visit where id='${firstVisit}'`),'');
 assert.equal((await x.report(k)).items.find(r=>r.status==='OPEN').ownerName,sql(`select name from client where id='${x.b}'`));
 const shipAgain=await x.ship(k);await clock('2026-09-21');const receivingAgain=await x.arrival(k,x.c);assert.notEqual(visit(k),firstVisit);assert.equal(owner(k),x.c);
 await x.cancel('receiving',receivingAgain.receiving);assert.equal(visit(k),firstVisit);assert.equal(owner(k),x.b);await x.cancel('shipping',shipAgain);assert.equal(owner(k),x.b);
 assert.equal(sql(`select count(*) from container_visit where container_id='${k}'`),'2');
 console.log('PASS shipping cancellation preserves B; repeat receiving creates another visit; cancellation restores previous visit and owner');

 const same=await x.arrival();const same1=await x.schedule([same.ktk],x.b,'2026-09-21');await x.waitStatus(same1);
 const same2=await x.schedule([same.ktk],x.c,'2026-09-21');await x.waitStatus(same2);
 report=(await x.report(same.ktk)).items;assert.deepEqual(report.map(r=>r.storageDays).sort(),[0,0,1]);
 await x.cancel('receiving',same.receiving);assert.equal((await x.report(same.ktk)).items.length,0);
 assert.equal(sql(`select count(*) from container_ownership_period where container_id='${same.ktk}' and record_type='STORAGE' and not is_cancelled`),'0');
 console.log('PASS multiple same-day transfers: 0/0/1 days; receiving cancellation annuls the entire visit, retaining history');

 const early=await x.arrival();const future=await x.schedule([early.ktk],x.b,'2026-09-25');const earlyShip=await x.ship(early.ktk);await x.waitStatus(future,'CANCELLED');assert.equal(row(future).result_status,'SKIPPED');
 await x.cancel('shipping',earlyShip);assert.equal(row(future).result_status,'SKIPPED');const secondShip=await x.ship(early.ktk);await x.arrival(early.ktk,x.c);
 await clock('2026-09-25');assert.equal(owner(early.ktk),x.c);assert.equal(countHistory(future),0);
 console.log('PASS shipping before transfer invalidates plan; cancellation does not revive it; next receiving is unaffected');

 const exp=await x.arrival(undefined,x.a,false);const expPlan=await x.schedule([exp.ktk],x.b,'2026-09-27');await x.cancel('receiving',exp.receiving);await x.waitStatus(expPlan,'CANCELLED');assert.equal(row(expPlan).result_status,'CANCELLED');
 const pair1=await x.arrival(),pair2=await x.arrival();const partial=await x.schedule([pair1.ktk,pair2.ktk],x.b,'2026-09-26');await x.ship(pair1.ktk);await clock('2026-09-26');await x.waitStatus(partial,'PARTIAL');assert.equal(owner(pair1.ktk),x.a);assert.equal(owner(pair2.ktk),x.b);assert.equal(countHistory(partial),1);
 console.log('PASS expected receiving cancellation; mixed batch completes only eligible KTK with PARTIAL result');

 const pending=await x.schedule([pair2.ktk],x.c,'2026-09-28');await api('/service-orders/'+pending+'/withdraw','POST');assert.equal(row(pending).container_visit_id,null);
 await api('/service-orders/'+pending,'PUT',{id:pending,service:'CHANGE_OWNER',effectiveDate:'2026-09-29'});await api('/service-orders/'+pending+'/accept','POST');
 run(['stop','billing-visit-check-new']);sql("update application_clock set business_date='2026-10-02',version=version+1 where id=1");run(['start','billing-visit-check-new']);await x.waitStatus(pending);assert.equal(owner(pair2.ktk),x.c);
 assert.equal(sql(`select (occurred_at at time zone 'Europe/Moscow')::date from container_owner_history where order_id='${pending}'`),'2026-09-29');
 await api('/container-storage-periods');assert.equal(countHistory(pending),1);
 console.log('PASS withdrawal/date edit; backend downtime executes at original effective date; retries do not duplicate history');

 const worker='billing-visit-check-worker';run(['run','-d','--name',worker,'--label','billing.task=visit-check','--network','billing-visit-check','-e','DB_HOST=billing-visit-check-db','-e','DB_NAME=billing_visit_check','-e','DB_USER=billing','-e','DB_PASSWORD=billing','-e','APP_OWNERSHIP_SCHEDULER_DELAY_MS=500','billing-visit-check-backend']);
 const race=await x.schedule([pair2.ktk],x.b,'2026-10-03');await clock('2026-10-03');await Promise.all(Array.from({length:8},()=>api('/service-orders/'+race)));await x.waitStatus(race);await pause(6000);assert.equal(countHistory(race),1);run(['stop',worker]);run(['rm',worker]);
 console.log('PASS two schedulers and parallel HTTP requests apply transfer once');

 const blocked=await x.schedule([pair2.ktk],x.c,'2026-10-04');sql(`update service_order_container set expected_client_id='${x.a}' where service_order_id='${blocked}'`);
 await clock('2026-10-04');await pause(1200);assert.equal(countHistory(blocked),0);assert.equal(owner(pair2.ktk),x.b);await api('/container-storage-periods','GET',undefined,409);
 assert.ok((await api('/service-orders/'+blocked)).containers[0].resultReason);await api('/service-orders/'+blocked+'/withdraw','POST');await api('/service-orders/'+blocked+'/accept','POST');await x.waitStatus(blocked);assert.equal(owner(pair2.ktk),x.c);
 console.log('PASS expected-owner mismatch rolls back execution, reports conflict, withdrawal/reconfirmation recovers');

 const v=visit(pair2.ktk);let rejected=false;try{sql(`begin;update container_ownership_period set client_id='${x.a}' where container_visit_id='${v}' and record_type='STORAGE';commit;`);}catch{rejected=true;}assert.ok(rejected);
 rejected=false;try{sql(`begin;update container_visit set receiving_date=receiving_date+1 where id='${v}';commit;`);}catch{rejected=true;}assert.ok(rejected);
 sql('do $$ declare r record;begin for r in select id from container_visit loop perform check_container_visit(r.id);end loop;end $$;');
 fs.writeFileSync('scenario-result.json',JSON.stringify({ok:true,partial,pending,race,blocked,container:pair2.ktk}));
 console.log('PASS database rejects ownership/date corruption; all visits reconcile with periods and history');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
