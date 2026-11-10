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





await send('Page.addScriptToEvaluateOnNewDocument',{source:"const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method&&!['GET','HEAD','OPTIONS'].includes(init.method.toUpperCase()))throw Error('Read-only layout audit');return originalFetch(input,init)}"});
const base='http://localhost:3001';const list=await(await fetch(base+'/api/comprehensive-service-orders')).json();const primary=list.items.find(r=>r.code===2862)||list.items.find(r=>r.workflow==='RAILWAY_RETURN');assert.ok(primary);const results=[];
for(const tab of ['shipping','receiving']) {
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+primary.id});await wait('document.getElementById("service-tab-'+tab+'")');await evaljs('document.getElementById("service-tab-'+tab+'").click()');await wait('document.querySelector("#service-panel-'+tab+' .create-route-button:not(:disabled)")');await evaljs('document.querySelector("#service-panel-'+tab+' .create-route-button:not(:disabled)").click()');await wait('document.querySelector(".route-side-dialog[open] input[type=datetime-local]")');await wait('Array.from(document.querySelectorAll(".route-side-dialog select")).every(e=>e.options.length>1)');
 await evaljs('(()=>{const dialog=document.querySelector(".route-side-dialog[open]"),input=dialog.querySelector("input[type=datetime-local]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"2026-11-06T12:00");input.dispatchEvent(new Event("input",{bubbles:true}));dialog.querySelectorAll("select").forEach(e=>{const option=[...e.options].find(o=>o.value&&!o.disabled);e.value=option.value;e.dispatchEvent(new Event("change",{bubbles:true}))});const text=dialog.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(text,"Проверка без сохранения");text.dispatchEvent(new Event("input",{bubbles:true}));})()');
 for(const width of [1440,1024,640,500,481,480,360,320]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(150);
  const state=await evaljs('(()=>{const d=document.querySelector(".route-side-dialog[open]"),body=d.querySelector(".route-drawer-body");return {text:body.textContent,headings:[...body.querySelectorAll("h2")].map(e=>e.textContent),overflow:body.scrollWidth>body.clientWidth+1,valid:d.querySelector("form").checkValidity(),date:d.querySelector("input[type=datetime-local]").value,comment:d.querySelector("textarea").value,fields:[...body.querySelectorAll(".field")].map(f=>{const l=f.querySelector("span"),c=f.querySelector("input,select,textarea"),lr=l.getBoundingClientRect(),cr=c.getBoundingClientRect();return {label:l.textContent,lx:lr.x,ly:lr.y,lr:lr.right,lb:lr.bottom,lh:lr.height,cx:cr.x,cy:cr.y,cw:cr.width}})}})()');
  assert.equal(state.overflow,false);assert.equal(state.valid,true);assert.equal(state.date,'2026-11-06T12:00');assert.equal(state.comment,'Проверка без сохранения');assert.deepEqual(state.headings,[]);assert.ok(!state.text.includes('будет добавлен в рейс'));assert.ok(!state.text.includes('Справочная информация'));assert.equal(state.fields.length,tab==='shipping'?5:2);
  for(const f of state.fields)if(width>480)assert.ok(f.cx>=f.lr+10,JSON.stringify(f));else assert.ok(f.cy>=f.lb,JSON.stringify(f));
  if(width>480)for(const f of state.fields)if(f.label.includes('ФИО'))assert.ok(f.lh<=20.1,'Driver label and required marker must share one line');
  results.push({tab,width,...state});if([1440,360].includes(width))fs.writeFileSync(path.join(dir,'../database/ui-standard-drawer-'+tab+'-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 await evaljs('document.querySelector(".route-side-dialog .close-button").click()');
}
await send('Page.navigate',{url:base+'/routes/new'});await wait('document.querySelector(".route-reference-section")');assert.ok(await evaljs('document.body.textContent.includes("Логистика")&&document.body.textContent.includes("Справочная информация")'));
fs.writeFileSync(path.join(dir,'../database/ui-standard-drawer-audit.json'),JSON.stringify(results,null,2));console.log('PASS',results.length,'drawer layouts, required fields, unsaved values, no reference block. PROFILE',profile);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
