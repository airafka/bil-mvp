// HISTORICAL: automatic edit on receipt tab was reverted. Use service-owner-create-ui.cjs instead.
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







await send('Page.addScriptToEvaluateOnNewDocument',{source: "window.__writes=[];const originalFetch=window.fetch;window.fetch=(input,init)=>{const method=(init?.method||'GET').toUpperCase();if(!['GET','HEAD','OPTIONS'].includes(method)){window.__writes.push({url:String(input),method,body:JSON.parse(init.body)});return Promise.reject(new Error('Проверка: запрос перехвачен без записи данных'))}return originalFetch(input,init)}"});
const base='http://localhost:3001',list=await(await fetch(base+'/api/receiving-orders?size=100')).json(),orders=list.items.filter(o=>o.transportType==='RAILWAY'&&o.status==='DRAFT'),results=[];assert.ok(orders.length);
const selector='.order-container-table select[aria-label^="Собственник КТК"]';
async function tab(label){await evaljs('Array.from(document.querySelectorAll(".view-tabs button")).find(b=>b.textContent==='+JSON.stringify(label)+').click()')}
for(const order of orders){
 const detail=await(await fetch(base+'/api/receiving-orders/'+order.id)).json();
 for(const width of [1440,360]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/receiving-orders/'+order.id});await wait('document.querySelector(".view-tabs button")');await tab('КТК');
  await wait('document.querySelector('+JSON.stringify(selector)+')?.options.length>2');
  const initial=await evaljs('Array.from(document.querySelectorAll('+JSON.stringify(selector)+')).map(e=>({label:e.getAttribute("aria-label"),value:e.value,disabled:e.disabled}))');
  assert.equal(initial.length,detail.containers.length);assert.ok(initial.every(s=>!s.disabled));
  assert.equal(await evaljs('window.__writes.length'),0);
  const chosen=await evaljs('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');const value=[...e.options].find(o=>o.value&&o.value!==e.value).value;e.value=value;e.dispatchEvent(new Event("change",{bubbles:true}));return value})()');
  await tab('Основное');await tab('КТК');assert.equal(await evaljs('document.querySelector('+JSON.stringify(selector)+').value'),chosen);
  assert.equal(await evaljs('window.__writes.length'),0);
  assert.equal(await evaljs('Array.from(document.querySelectorAll(".order-container-table select,.order-container-table input")).filter(e=>e.type!=="checkbox"&&!e.getAttribute("aria-label")?.startsWith("Собственник КТК")).length'),0);
  assert.equal(await evaljs('document.documentElement.scrollWidth>innerWidth+1'),false);
  await evaljs('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Отмена").click()');await tab('КТК');await wait('document.querySelector('+JSON.stringify(selector)+')?.options.length>2');assert.equal(await evaljs('document.querySelector('+JSON.stringify(selector)+').value'),initial[0].value);
  await evaljs('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(chosen)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await evaljs('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Сохранить").click()');await wait('window.__writes.length===1');
  const request=await evaljs('window.__writes[0]');assert.equal(request.method,'PATCH');assert.ok(request.url.endsWith('/receiving-orders/'+order.id+'/containers'));
  const changedContainer=detail.containers.find(c=>'Собственник КТК — '+c.containerName===initial[0].label);assert.ok(changedContainer);
  assert.equal(request.body.containers.find(c=>c.containerId===changedContainer.containerId).ownerClientId,chosen);
  for(const row of request.body.containers){assert.equal(row.sealNumbers,null);assert.equal(row.sealTypeId,null);assert.equal(row.hazardClassId,null);if(row.containerId!==changedContainer.containerId)assert.equal(row.ownerClientId,detail.containers.find(c=>c.containerId===row.containerId).ownerClientId||null)}
  results.push({code:order.code,width,containers:initial.length,requestIntercepted:true});
 }
}
fs.writeFileSync(path.join(dir,'../database/railway-owner-edit-ui-audit.json'),JSON.stringify(results,null,2));console.log('PASS',JSON.stringify(results),'PROFILE',profile);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
