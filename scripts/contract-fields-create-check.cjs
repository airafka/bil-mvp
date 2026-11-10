const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const s=JSON.parse(fs.readFileSync('database/contract-fields-session.json'));assert.match(s.database,/^billing_next_contract_fields_\d{8}_\d{6}$/);
const docker='C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';const run=a=>execFileSync(docker,a,{windowsHide:true,encoding:'utf8'}).trim();
assert.ok(JSON.parse(run(['inspect',s.backend]))[0].Config.Env.includes('DB_NAME='+s.database));
const sql=q=>run(['exec','billing-next-db-1','psql','-X','-U','billing','-d',s.database,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const backup=s.database+'-before-create.dump';run(['exec','billing-next-db-1','pg_dump','-U','billing','-d',s.database,'-Fc','-f','/tmp/'+backup]);run(['cp','billing-next-db-1:/tmp/'+backup,path.resolve('database',backup)]);
async function api(p,body){const r=await fetch('http://localhost:8192/api'+p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await r.json();assert.equal(r.status,body?201:200,JSON.stringify(data));return data;}
(async()=>{const service=(await api('/comprehensive-service-orders/available-services'))[0];const pair=JSON.parse(sql("SELECT row_to_json(t) FROM (SELECT client_id,contract_id FROM complex_service_tariff WHERE active AND complex_service_id='"+service.id+"' LIMIT 1)t"));
const bill=await api('/waybills/generate',{standard20:1,standard40:0});const before=Date.now();
const result=await api('/comprehensive-service-orders',{clientId:pair.client_id,contractId:pair.contract_id,complexServiceId:service.id,defaultContainerOwnerId:pair.client_id,waybillIds:[bill.id]});
const after=Date.now(),created=Date.parse(result.order.createdAt);assert.ok(created>=before-2000&&created<=after+2000);assert.ok(result.order.code);const loaded=await api('/comprehensive-service-orders/'+result.order.id);assert.equal(loaded.order.createdAt,result.order.createdAt);assert.equal(loaded.order.code,result.order.code);
fs.writeFileSync('database/contract-fields-create-check.json',JSON.stringify({database:s.database,id:result.order.id,number:result.order.code,createdAt:result.order.createdAt,checks:['created_at assigned by server without input','number assigned automatically','date and number preserved after reload']},null,2));console.log('PASS automatic number and created_at saved and returned after reload');
})().catch(e=>{console.error(e);process.exitCode=1});
