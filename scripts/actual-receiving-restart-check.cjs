const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');const docker=process.env.DOCKER_EXE||'docker',pg='billing-actual-receiving-db',db='billing_actual_receiving_test';
const run=(a,input)=>execFileSync(docker,a,{input,encoding:'utf8',windowsHide:true,maxBuffer:30*1024*1024}).trim();const sql=q=>run(['exec','-i',pg,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],q),json=q=>JSON.parse(sql(q));const base='http://127.0.0.1:8335/api';
async function api(p,method='GET',body){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();assert.ok(r.ok,t);return t?JSON.parse(t):null;}
async function main(){const info=JSON.parse(run(['inspect','billing-actual-receiving-new']))[0];assert.equal(info.Config.Labels['billing.task'],'actual-receiving');assert.ok(info.Config.Env.includes('DB_NAME='+db));
const candidate=json("select row_to_json(t) from (select o.id,o.container_id,o.client_id from container_owner_current o join container_visit v on v.id=o.container_visit_id where o.status='ON_TERMINAL' and not v.is_cancelled order by v.created_at desc limit 1)t");const other=sql(`select id from client where id<>'${candidate.client_id}' order by id limit 1`);
const plan=await api('/service-orders','POST',{clientId:other,service:'CHANGE_OWNER',effectiveDate:'2026-10-10',containerOwnerIds:[candidate.id]});await api('/service-orders/'+plan.order.id+'/accept','POST');
const history=sql('select json_agg(h order by id) from container_owner_history h'),periods=sql('select json_agg(p order by id) from container_ownership_period p');
run(['stop','billing-actual-receiving-new']);sql("update application_clock set business_date='2026-10-11',version=version+1 where id=1");run(['start','billing-actual-receiving-new']);
for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break}catch{}await new Promise(r=>setTimeout(r,300));}
assert.equal(sql(`select client_id from container_owner_current where container_id='${candidate.container_id}'`),other);assert.equal(sql('select json_agg(h order by id) from container_owner_history h'),history);assert.equal(sql('select json_agg(p order by id) from container_ownership_period p'),periods);
console.log('PASS: after backend downtime and calendar advance owner changes by date without new period/history writes');
// SQL integrity: a visit cannot be inserted without an actual receiving event.
let rejected=false;try{sql("begin; insert into container_visit(id,container_id,receiving_order_id,receiving_order_container_id) select gen_random_uuid(),container_id,receiving_order_id,id from receiving_order_container limit 1; rollback;")}catch{rejected=true}assert.ok(rejected);
console.log('PASS: database rejects a visit without a factual receiving date/event');}
main().catch(e=>{console.error(e);process.exitCode=1});
