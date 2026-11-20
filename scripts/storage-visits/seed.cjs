const {assert,run,sql,fs,api,clock,init,capture}=require('./check-lib.cjs');
(async()=>{const x=await init('billing-visit-ui-check-old');await clock('2026-09-15');const r=await x.arrival();await clock('2026-09-17');await x.schedule([r.ktk],x.c,'2026-09-17');await x.schedule([r.ktk],x.b,'2026-09-17');await x.schedule([r.ktk],x.a,'2026-09-23');await clock('2026-09-20');const shipping=await x.ship(r.ktk);
const plain=await x.arrival(),cancelled=await x.arrival();await x.cancel('receiving',cancelled.receiving);
const long=await x.arrival();for(let i=0;i<24;i++)await x.schedule([long.ktk],i%2?x.a:x.b,'2026-09-20');
await clock('2026-09-21');const repeated=await x.arrival(r.ktk,x.a);await x.schedule([r.ktk],x.b,'2026-09-23');await clock('2026-09-22');
fs.writeFileSync('fixtures.json',JSON.stringify({r,shipping,repeated,plain,cancelled,long,a:x.a,b:x.b,c:x.c,code:sql(`select code from container where id='${r.ktk}'`)}));fs.writeFileSync('before-api.json',JSON.stringify(await capture()));
run(['stop','billing-visit-ui-check-old']);fs.writeFileSync('seed-tables.json',JSON.stringify(require('./ops.cjs').snapshot('billing-visit-ui-check-db','billing_visit_ui_check')));
console.log('PASS closed/repeated/plain/cancelled/future and 25-period visits seeded');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
