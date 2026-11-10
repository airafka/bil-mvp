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








const base='http://localhost:3001',f=JSON.parse(fs.readFileSync(path.join(dir,'../database/service-owner-create-check.json'))).ui;
const available=(await(await fetch(base+'/api/waybills/available?size=100')).json()).content;
const row=available.find(r=>r.waybill.number==='1743125951')||available.find(r=>r.waybill.containerCount>1&&r.waybill.containerCount<40);assert.ok(row);f.bill={...row.waybill,departureStation:row.departureStation,destinationStation:row.destinationStation,payer:row.payer};
await send('Page.addScriptToEvaluateOnNewDocument',{source:"const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method&&!['GET','HEAD','OPTIONS'].includes(init.method.toUpperCase()))throw Error('Read-only layout audit');return originalFetch(input,init)}"});
const select=async(selector,value)=>{await wait('document.querySelector('+JSON.stringify(selector)+')&&!document.querySelector('+JSON.stringify(selector)+').disabled');await evaljs('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(String(value))+';e.dispatchEvent(new Event("change",{bubbles:true}))})()')};
const field=async(label,value)=>{await evaljs('(()=>{const e=[...document.querySelectorAll("label.field")].find(e=>e.textContent.startsWith('+JSON.stringify(label)+')).querySelector("select");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()')};
const next=async()=>{await wait('document.querySelector(".page-header .primary-button:not(:disabled)")');await evaljs('document.querySelector(".page-header .primary-button").click()');await pause(100)};
const step=async(label)=>{await evaljs('Array.from(document.querySelectorAll(".stepper button")).find(b=>b.textContent==='+JSON.stringify(label)+').click()');await pause(100)};
await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/comprehensive-service-orders/new'});await wait('document.querySelector("select[aria-label=Услуга]")?.options.length>1');
await select('select[aria-label=Услуга]',f.service);await field('Клиент:',f.client);await field('Договор:',f.contract);await select('select[aria-label="Собственник КТК по умолчанию"]',f.client);
await select('select[aria-label="Станция отправления"]',f.bill.departureStation);await select('select[aria-label="Станция назначения"]',f.bill.destinationStation);await select('select[aria-label="Плательщик"]',f.bill.payer);await next();
const billSelector='input[aria-label="Выбрать накладную '+f.bill.number+'"]';
for(let i=0;i<20;i++){await wait('document.querySelector(".waybill-selection-table[aria-busy=false]")');if(await evaljs('!!document.querySelector('+JSON.stringify(billSelector)+')'))break;assert.ok(await evaljs('(()=>{const b=[...document.querySelectorAll(".waybill-selection-footer button")].find(b=>b.textContent==="Далее"&&!b.disabled);if(!b)return false;b.click();return true})()'));}
await evaljs('document.querySelector('+JSON.stringify(billSelector)+').click()');await next();assert.equal(await evaljs('document.querySelector(".stepper .current").textContent'),'Вагоны');await next();
const owner='.order-container-table select[aria-label^="Собственник КТК"]';await wait('document.querySelector('+JSON.stringify(owner)+')?.options.length>1');const initial=await evaljs('Array.from(document.querySelectorAll('+JSON.stringify(owner)+')).map(e=>({label:e.getAttribute("aria-label"),value:e.value}))');assert.equal(initial.length,f.bill.containerCount);assert.ok(initial.every(x=>x.value===f.client));
await select(owner,f.otherOwner);await next();await step('КТК');await wait('document.querySelector('+JSON.stringify(owner)+')?.options.length>1');assert.equal(await evaljs('document.querySelector('+JSON.stringify(owner)+').value'),f.otherOwner);

const layouts=[];
for(const width of [1920,1440,1366,1340,1280,1024,360,320]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(150);
 const state=await evaljs('(()=>{const t=document.querySelector(".order-container-table"),s=t.querySelector("select"),r=s.closest("tr");return {parentWidth:t.parentElement.clientWidth,records:t.classList.contains("responsive-table--records"),rowHeight:r.getBoundingClientRect().height,ownerValue:s.value,overflow:document.documentElement.scrollWidth>innerWidth+1,cellTops:[...r.cells].map(c=>c.getBoundingClientRect().top)}})()');
 assert.equal(state.overflow,false);assert.equal(state.ownerValue,f.otherOwner);assert.equal(state.records,state.parentWidth<1140);
 if(width>=1340){assert.equal(state.records,false);assert.ok(state.rowHeight<140);assert.ok(state.cellTops.every(y=>Math.abs(y-state.cellTops[0])<1),'Owner must stay in same table row')}
 layouts.push({width,...state});if([1366,360].includes(width))fs.writeFileSync(path.join(dir,'../database/service-owner-inline-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
}
await send('Emulation.setDeviceMetricsOverride',{width:1366,height:1000,deviceScaleFactor:1,mobile:false});await evaljs('document.querySelector(".composition-group button").click()');await pause(100);assert.equal(await evaljs('document.querySelector(".order-container-table").classList.contains("responsive-table--records")'),false);await evaljs('document.querySelector(".composition-group button").click()');await wait('document.querySelector('+JSON.stringify(owner)+')');assert.equal(await evaljs('document.querySelector('+JSON.stringify(owner)+').value'),f.otherOwner);
fs.writeFileSync(path.join(dir,'../database/service-owner-inline-audit.json'),JSON.stringify(layouts,null,2));console.log('PASS inline table hierarchy',JSON.stringify(layouts.map(({width,records,rowHeight})=>({width,records,rowHeight}))),'PROFILE',profile);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
