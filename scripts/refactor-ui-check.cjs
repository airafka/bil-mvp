const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=__dirname,profile=path.join(dir,'route-layout-test-profile-'+Date.now());fs.mkdirSync(profile);
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
let port;for(let i=0;i<80;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await pause(100)}assert.ok(port,'Headless browser startup');
const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)}});
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,{resolve:r=>{clearTimeout(timeout);resolve(r)},reject:e=>{clearTimeout(timeout);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaljs(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression){for(let i=0;i<70;i++){if(await evaljs('Boolean('+expression+')'))return;await pause(100)}throw Error('Timeout: '+expression)}
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});









const session=JSON.parse(fs.readFileSync(path.join(dir,'../database/refactor-20261109-session.json'),'utf8').replace(/^\uFEFF/,''));const {execFileSync}=require('node:child_process');const docker='C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';assert.match(session.database,/^billing_next_refactor_\d{8}_\d{6}$/);const config=JSON.parse(execFileSync(docker,['inspect',session.backend],{windowsHide:true,encoding:'utf8'}))[0];assert.ok(config.Config.Env.includes('DB_NAME='+session.database));
const base='http://localhost:3192',api='http://localhost:8192',requests=[],errors=[];await send('Network.enable');ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent'&&m.params.request.url.startsWith(base+'/api/'))requests.push({url:m.params.request.url.slice(base.length),method:m.params.request.method});if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
const before=JSON.parse(fs.readFileSync(path.join(dir,'../database/refactor-20261109-before.json'),'utf8'));
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+before.serviceId});await wait('document.querySelector("#service-panel-shipping table")');await pause(700);const initialRequests=[...requests];assert.equal(initialRequests.length,1,JSON.stringify(initialRequests));
const service=await(await fetch(api+'/api/comprehensive-service-orders/'+before.serviceId)).json();
for(const width of [1440,1024,640,360,320]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
 for(const tab of ['receiving','shipping','returns']){await evaljs(`document.getElementById('service-tab-${tab}').click()`);await pause(100);const links=await evaljs(`Array.from(document.querySelectorAll('#service-panel-${tab} a[href^="/routes/"]'),e=>({id:e.getAttribute('href').split('/').pop(),text:e.textContent}))`);for(const link of links){const route=service.transportOrders.find(o=>o.route?.id===link.id)?.route;assert.ok(route);assert.equal(link.text,'Рейс '+route.code)}assert.equal(await evaljs('document.documentElement.scrollWidth>innerWidth+1'),false);}
}
assert.equal(requests.length,1,'Transport tabs do not fetch row details');await evaljs(`document.getElementById('service-tab-charges').click()`);await wait('document.querySelector("#service-panel-charges tbody tr")');assert.equal(requests.filter(x=>x.url.startsWith('/api/billing-charges')).length,1);
const links=await evaljs(`Array.from(document.querySelectorAll('.nav-entry a'),e=>e.getAttribute('href'))`);for(const url of links){await send('Page.navigate',{url:base+url});await wait('document.querySelector(".content h1")');await pause(200);assert.equal(await evaljs(`document.body.textContent.includes('Не удалось загрузить')`),false,url)}
// Creation is exercised only against the prepared test database.
const services=await(await fetch(api+'/api/comprehensive-service-orders?size=100')).json();const candidates=[];for(const s of services.items){const detail=await(await fetch(api+'/api/comprehensive-service-orders/'+s.id)).json();for(const o of detail.transportOrders)if(o.status==='DRAFT'&&!o.route)candidates.push({serviceId:s.id,order:o,tab:o.kind==='SHIPPING'?'shipping':detail.order.workflow==='AUTO_RETURN'||detail.returnOrders.some(r=>r.id===o.id)?'returns':'receiving'})}
const created=[];for(const transportType of ['RAILWAY','VEHICLE']){
 const candidate=candidates.find(c=>c.order.transportType===transportType);assert.ok(candidate,'Draft '+transportType+' required in prepared test data');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+candidate.serviceId});await wait(`document.getElementById('service-tab-${candidate.tab}')`);await evaljs(`document.getElementById('service-tab-${candidate.tab}').click()`);await pause(100);
 await evaljs(`document.querySelector('a[href="/${candidate.order.kind==='SHIPPING'?'shipping-orders':'receiving-orders'}/${candidate.order.id}"]').closest('tr').querySelector('.create-route-button').click()`);await wait('document.querySelector("dialog[open]")');
 await evaljs(`(()=>{const input=document.querySelector('dialog input[type="datetime-local"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2026-11-09T12:30');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 if(transportType==='VEHICLE'){await wait('document.querySelectorAll("dialog select:not(:disabled)").length===3');await evaljs(`document.querySelectorAll('dialog select').forEach(s=>{s.value=Array.from(s.options).find(o=>o.value&&!o.disabled).value;s.dispatchEvent(new Event('change',{bubbles:true}))})`)}
 await evaljs(`document.querySelector('dialog form').requestSubmit()`);await wait('!document.querySelector("dialog[open]")');
 const fresh=await(await fetch(api+'/api/comprehensive-service-orders/'+candidate.serviceId)).json();const order=fresh.transportOrders.find(o=>o.id===candidate.order.id);assert.ok(order.route);created.push({orderId:order.id,kind:order.kind,transportType,routeId:order.route.id});
 await send('Page.reload');await wait(`document.querySelector('a[href="/routes/${order.route.id}"]')`);
}
assert.deepEqual(errors,[]);const report={before:before.requests.length,after:initialRequests.length,initialRequests,viewports:[1440,1024,640,360,320],registryRoutes:links.length,created,database:session.database,errors};fs.writeFileSync(path.join(dir,'../database/refactor-20261109-ui-check.json'),JSON.stringify(report,null,2));console.log('PASS',JSON.stringify(report));ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});