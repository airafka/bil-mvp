const {assert,run,sql,json,fs,api,clock,init,capture}=require('./check-lib.cjs');
(async()=>{
 const x=await init();assert.equal(sql('select max(version::int) from flyway_schema_history'),'55');await clock('2026-09-15');
 const expected=await x.arrival(undefined,x.a,false);const expectedTransfer=await x.schedule([expected.ktk],x.b,'2026-09-15');await x.waitStatus(expectedTransfer);
 const future=await x.arrival();const scheduled=await x.schedule([future.ktk],x.b,'2026-09-17');
 const cancelExpected=await x.arrival(undefined,x.a,false);await x.cancel('receiving',cancelExpected.receiving);
 const cancelArrival=await x.arrival();await x.cancel('receiving',cancelArrival.receiving);
 fs.writeFileSync('fixture.json',JSON.stringify({expected,future,scheduled,cancelExpected,cancelArrival,...Object.fromEntries(['a','b','c'].map(k=>[k,x[k]]))}));
 fs.writeFileSync('before-report.json',JSON.stringify(await capture()));
 fs.writeFileSync('before-history.json',sql('select json_agg(h order by id) from container_owner_history h'));
 run(['stop','billing-dated-check-old']);
 run(['exec','billing-dated-check-db','pg_dump','-U','billing','-d','billing_dated_check','-Fc','-f','/tmp/seeded.dump']);
 run(['cp','billing-dated-check-db:/tmp/seeded.dump','seeded.dump']);
 console.log('PASS old V55 seeded: expected owner transfer, future plan, cancelled reservation and receiving; baseline report/CSV/history saved');
})().catch(e=>{console.error(e.message);process.exitCode=1});
