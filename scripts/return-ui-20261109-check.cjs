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








const {execFileSync}=require('child_process');const session=JSON.parse(fs.readFileSync(path.join(dir,'../database/auto20-20261109-session.json'),'utf8').replace(/^\uFEFF/,''));
assert.match(session.database,/^billing_next_auto20_/);const info=JSON.parse(execFileSync('C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe',['inspect',session.backend],{encoding:'utf8',windowsHide:true}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+session.database));
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../database/auto20-20261109-ui.json'),'utf8'));assert.equal(fixture.database,session.database);
const base='http://localhost:3192',url=base+'/comprehensive-service-orders/'+fixture.createdId;
const before=await(await fetch(base+'/api/comprehensive-service-orders/'+fixture.createdId)).json();assert.equal(before.returnOrders.length,0);
await send('Page.navigate',{url});await wait('document.querySelector("#service-tab-shipping")');assert.equal(await evaljs('!!document.querySelector("#service-tab-returns")'),false);
await evaljs('document.querySelector("#service-tab-shipping").click()');await evaljs('[...document.querySelectorAll("button")].find(e=>e.textContent==="Создать возврат").click()');await wait('document.querySelector("dialog[open] .return-current-client")');
assert.equal(await evaljs('document.querySelector(".return-current-client").textContent'),'Использовать текущего клиента и договор');
assert.equal(await evaljs('[...document.querySelectorAll("dialog h3")].some(e=>e.textContent==="КТК к возврату")'),false);
assert.equal(await evaljs('document.querySelector(".return-current-client input").checked'),false);
for(const width of [1440,360]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(200);assert.equal(await evaljs('document.documentElement.scrollWidth>innerWidth+1'),false);fs.writeFileSync(path.join(dir,'../database/return-ui-20261109-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
await evaljs('document.querySelector(".return-current-client input").click()');await evaljs('document.querySelector(".return-container-table thead input").click()');
await evaljs('document.querySelector("dialog button[type=submit]").click()');await wait('!document.querySelector("dialog[open]")&&document.querySelector("#service-tab-returns")');
await evaljs('[...document.querySelectorAll("button")].find(e=>e.textContent==="Показать возвраты").click()');assert.equal(await evaljs('document.querySelector("#service-tab-returns").getAttribute("aria-selected")'),'true');
const after=await(await fetch(base+'/api/comprehensive-service-orders/'+fixture.createdId)).json();assert.equal(after.returnOrders.filter(r=>r.comprehensiveServiceOrderId===fixture.createdId).length,3);
await send('Page.navigate',{url});await wait('document.querySelector("#service-tab-returns")');
const other=JSON.parse(fs.readFileSync(path.join(dir,'../database/auto20-20261109-check.json'),'utf8')).cases[0].id;
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+other});await wait('document.querySelector("#service-tab-shipping")');assert.equal(await evaljs('!!document.querySelector("#service-tab-returns")'),false);
fs.writeFileSync(path.join(dir,'../database/return-ui-20261109-check.json'),JSON.stringify({database:session.database,service:fixture.createdId,newLabel:true,noTableHeading:true,hiddenWithoutReturns:true,visibleAfterCreation:true,visibleAfterReload:true,createdReturns:3,layouts:[1440,360]},null,2));
console.log('PASS return label, no heading, hidden/appearing/persisted return tab, layouts1440/360; mutations only test DB');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
