const {assert,sql,fs,api,clock,init,capture}=require('./check-lib.cjs');const {snapshot}=require('./ops.cjs');
(async()=>{await init('billing-visit-ui-check-new');const f=JSON.parse(fs.readFileSync('fixtures.json'));assert.deepEqual(await capture(),JSON.parse(fs.readFileSync('before-api.json')));
const q=k=>'/container-storage-periods/visits?query='+sql(`select code from container where id='${k}'`);
const visits=await api(q(f.r.ktk)+'&size=1');assert.equal(visits.totalElements,2);assert.equal(visits.items.length,1);assert.equal(visits.items[0].receivingOrderId,f.repeated.receiving);assert.equal(visits.items[0].periods.length,1);assert.equal(visits.items[0].storageDays,2);assert.ok(visits.items[0].shippingAt == null);
const closed=(await api(q(f.r.ktk)+'&size=1&page=1')).items[0];assert.equal(closed.receivingOrderId,f.r.receiving);assert.equal(closed.shippingOrderId,f.shipping);assert.equal(closed.periods.length,3);assert.deepEqual(closed.periods.map(p=>p.storageDays),[2,0,4]);assert.equal(closed.storageDays,6);
const deep=(await api('/container-storage-periods/visits?periodId='+closed.periods[1].id)).items[0];assert.deepEqual(deep,closed);
const past=(await api(q(f.r.ktk)+'&asOf=2026-09-16')).items;assert.equal(past.length,1);assert.equal(past[0].periods.length,1);assert.equal(past[0].storageDays,2);assert.ok(past[0].shippingAt == null);
assert.equal((await api(q(f.plain.ktk))).items[0].periods.length,1);assert.equal((await api(q(f.cancelled.ktk))).totalElements,0);
const long=(await api(q(f.long.ktk)+'&size=1')).items[0];assert.equal(long.periods.length,25);assert.equal(long.storageDays,3);
assert.equal((await api('/container-storage-periods/visits?query=NO_SUCH_KTK')).totalElements,0);
await api('/container-storage-periods/visits?asOf=2026-09-23','GET',undefined,400);
const all=(await api('/container-storage-periods/visits?size=100')).items;for(const v of all){assert.equal(v.storageDays,v.periods.reduce((n,p)=>n+p.storageDays,0));assert.ok(v.periods.every(p=>p.containerId===v.containerId));}
assert.deepEqual(snapshot('billing-visit-ui-check-db','billing_visit_ui_check'),JSON.parse(fs.readFileSync('seed-tables.json')));
await clock('2026-09-23');assert.equal((await api(q(f.r.ktk))).items[0].periods.length,2);await clock('2026-09-22');assert.equal((await api(q(f.r.ktk))).items[0].periods.length,1);
fs.writeFileSync('check-ok.json',JSON.stringify({closed,code:f.code,long:long.containerName}));console.log('PASS whole-visit pagination, repeated receiving, 2/0/4 days, 25 periods, future/calendar, cancellation, deep link, empty/error; legacy API/CSV unchanged; reads preserve data');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
