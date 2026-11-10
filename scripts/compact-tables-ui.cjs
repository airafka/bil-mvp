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




const base='http://localhost:3001';
// Read-only audit of the deployed frontend; no style injection or form submission.
const rows=await(await fetch(base+'/api/comprehensive-service-orders')).json();

const list=Array.isArray(rows)?rows:rows.content||rows.items||[];
const services=[];
for(const row of list){const d=await(await fetch(base+'/api/comprehensive-service-orders/'+row.id)).json();if(d.order)services.push(d)}
assert.ok(services.length);
const primary=services.find(d=>d.order.code===2862)||services.find(d=>d.shippingOrders?.length)||services[0];
const routes=['receiving-orders','shipping-orders','comprehensive-service-orders','service-orders','routes','waybills','containers','railway-carriages','transport-carriers','transport-drivers','transport-vehicles','complex-services','container-owners','billing-charges','payment-invoices',...services.map(d=>'comprehensive-service-orders/'+d.order.id),...(primary.receivingOrder?['receiving-orders/'+primary.receivingOrder.id]:[]),...(primary.shippingOrders?.slice(0,1).map(o=>'shipping-orders/'+o.id)||[])];
const results=[],failures=[];
async function check(label){await pause(120);const r=await evaljs(String.raw`(()=>{const shown=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;return {overflow:document.documentElement.scrollWidth>innerWidth+1,tables:[...document.querySelectorAll('.content table')].filter(shown).map(t=>({cls:t.className,w:Math.round(t.getBoundingClientRect().width),parent:t.parentElement.clientWidth,gap:Math.round(t.parentElement.clientWidth-t.getBoundingClientRect().width),columns:[...(t.tHead?.rows[0]?.cells||[])].map(c=>({label:c.textContent,w:Math.round(c.getBoundingClientRect().width)}))})),wide:[...document.querySelectorAll('.content table,.table-wrap,.form-workspace')].filter(shown).filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.className),buttons:[...document.querySelectorAll('table button')].filter(shown).filter(b=>b.textContent==='Создать рейс').map(b=>({h:b.clientHeight,w:b.clientWidth,whiteSpace:getComputedStyle(b).whiteSpace}))}})()`);results.push({label,...r});if(r.overflow||r.wide.length||r.tables.some(t=>t.gap>2)||r.buttons.some(b=>b.h>32||b.whiteSpace!=='nowrap'))failures.push({label,...r});}
for(const width of (process.argv.includes('--details')?[]:[2320,1920,1440,1024,640,360,320])){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
 for(const route of routes){
  await send('Page.navigate',{url:base+'/'+route});await wait('document.querySelector(".content h1")');await pause(200);
  await check(width+' '+route);
  if(route.startsWith('comprehensive-service-orders/'))for(const tab of ['receiving','shipping','returns','charges']){await evaljs('document.getElementById("service-tab-'+tab+'")?.click()');await pause(200);await check(width+' '+route+' '+tab);if(route.endsWith(primary.order.id)&&tab==='shipping'&&[2320,1440,360].includes(width))fs.writeFileSync(path.join(dir,'../database/compact-tables-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
 }
 console.log('DONE',width,'checks',results.length,'failures',failures.length);fs.writeFileSync(path.join(dir,process.argv.includes('--details')?'../database/compact-tables-details-audit.json':'../database/compact-tables-audit.json'),JSON.stringify({results,failures},null,2));
}

if(process.argv.includes('--details')) {
 await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+primary.order.id});
 await wait('document.getElementById("service-tab-shipping")');
 await evaljs('document.getElementById("service-tab-shipping").click();document.querySelector("button[aria-label=Редактировать]").click()');
 await wait('document.querySelector("#service-panel-shipping input[type=datetime-local]")');
 await evaljs('(()=>{const e=document.querySelector("#service-panel-shipping input[type=datetime-local]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"2026-11-06T12:34");e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');
 for(const width of [2320,1440,1024,640,360,320]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  await evaljs('(()=>{const shell=document.querySelector(".app-shell");if(shell.dataset.menuExpanded!==String('+ (width>640)+'))document.querySelector(".menu-toggle").click()})()');
  await check(width+' expanded menu, service editing');
  assert.equal(await evaljs('document.querySelector("#service-panel-shipping input[type=datetime-local]").value'),'2026-11-06T12:34');
 }

 await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+primary.order.id});
 await wait('document.getElementById("service-tab-shipping")');
 await evaljs('document.getElementById("service-tab-shipping").click()');
 await wait('document.querySelector(".service-tab-actions > button")');
 await evaljs('document.querySelector(".service-tab-actions > button").click()');
 await wait('document.querySelector(".return-dialog[open] table.responsive-table")');
 for(const width of [2320,1440,1024,640,360,320]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  await pause(200);
  const geometry=await evaljs('(()=>{const table=document.querySelector(".return-dialog table"),p=table.parentElement;return {gap:p.clientWidth-table.getBoundingClientRect().width,overflow:p.scrollWidth>p.clientWidth+2,checkbox:table.tHead.rows[0].cells[0].getBoundingClientRect().width,selected:document.querySelector(".return-dialog input[aria-label=\\"Выбрать все КТК\\"]").checked}})()');
  assert.ok(Math.abs(geometry.gap)<3,JSON.stringify({width,...geometry}));assert.equal(geometry.overflow,false);assert.equal(geometry.selected,false);
  if(width>=360)assert.ok(geometry.checkbox<=45,'Checkbox column stays compact');
  await evaljs('document.querySelector(".return-dialog input[aria-label=\\"Выбрать все КТК\\"]").click()');
  assert.equal(await evaljs('[...document.querySelectorAll(".return-dialog tbody input[type=checkbox]")].every(e=>e.checked)'),true);
  await evaljs('document.querySelector(".return-dialog input[aria-label=\\"Выбрать все КТК\\"]").click()');
  if([1440,360].includes(width))fs.writeFileSync(path.join(dir,'../database/return-table-filled-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  console.log('PASS return dialog',width,'table fills frame, checkbox',geometry.checkbox);
 }
 await evaljs('document.querySelector("button[aria-label=\\"Закрыть форму возврата\\"]").click()');
 const forms=['receiving-orders/new','shipping-orders/new','comprehensive-service-orders/new','service-orders/new','routes/new','waybills/create','waybills/generate','complex-services/new','payment-invoices/new','transport-carriers/new','transport-drivers/new','transport-vehicles/new'];
 for(const width of [1440,640,320]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  for(const route of forms){await send('Page.navigate',{url:base+'/'+route});await wait('document.querySelector(".content h1")');await pause(200);await check(width+' form '+route)}
 }
}
fs.writeFileSync(path.join(dir,process.argv.includes('--details')?'../database/compact-tables-details-audit.json':'../database/compact-tables-audit.json'),JSON.stringify({results,failures},null,2));
console.log('CHECKS',results.length,'FAILURES',JSON.stringify(failures.map(f=>({label:f.label,overflow:f.overflow,wide:f.wide,buttons:f.buttons,gaps:f.tables.map(t=>t.gap)}))));assert.equal(failures.length,0);
ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
