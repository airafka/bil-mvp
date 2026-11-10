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








const {execFileSync}=require('child_process');
const session=JSON.parse(fs.readFileSync(path.join(dir,'../database/auto20-20261109-session.json'),'utf8').replace(/^\uFEFF/,''));
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../database/auto20-20261109-check.json'),'utf8')),f=fixture.ui;
assert.match(session.database,/^billing_next_auto20_/);assert.equal(fixture.database,session.database);
const info=JSON.parse(execFileSync('C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe',['inspect',session.backend],{encoding:'utf8',windowsHide:true}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+session.database));assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8192'));
const base='http://localhost:3192';assert.equal((await fetch(base+'/api/comprehensive-service-orders/'+fixture.cases[0].id)).status,200);
const select=async(selector,value)=>{await wait('document.querySelector('+JSON.stringify(selector)+')&&!document.querySelector('+JSON.stringify(selector)+').disabled');await evaljs('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(String(value))+';e.dispatchEvent(new Event("change",{bubbles:true}))})()')};
const field=async(label,value)=>{await evaljs('(()=>{const e=[...document.querySelectorAll("label.field")].find(e=>e.textContent.startsWith('+JSON.stringify(label)+')).querySelector("select");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()')};
const next=async()=>{await wait('document.querySelector(".page-header .primary-button:not(:disabled)")');await evaljs('document.querySelector(".page-header .primary-button").click()');await pause(100)};
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:base+'/comprehensive-service-orders/new'});await wait('document.querySelector("select[aria-label=Услуга]")?.options.length>1');
await select('select[aria-label=Услуга]',f.service);await field('Клиент:',f.client);await field('Договор:',f.contract);await select('select[aria-label="Собственник КТК по умолчанию"]',f.client);
await select('select[aria-label="Станция отправления"]',f.bill.departureStation);await select('select[aria-label="Станция назначения"]',f.bill.destinationStation);await select('select[aria-label="Плательщик"]',f.bill.payer);await next();
const billSelector='input[aria-label="Выбрать накладную '+f.bill.number+'"]';
for(let i=0;i<20;i++){await wait('document.querySelector(".waybill-selection-table[aria-busy=false]")');if(await evaljs('!!document.querySelector('+JSON.stringify(billSelector)+')'))break;assert.ok(await evaljs('(()=>{const b=[...document.querySelectorAll(".waybill-selection-footer button")].find(b=>b.textContent==="Далее"&&!b.disabled);if(!b)return false;b.click();return true})()'));}
await evaljs('document.querySelector('+JSON.stringify(billSelector)+').click()');await next();
assert.equal(await evaljs('document.querySelector(".stepper .current").textContent'),'Вагоны','Train service with 3 containers must advance');
await next();await next();await next();
await wait('location.pathname!=="/comprehensive-service-orders/new"&&document.querySelector(".service-dashboard")');
const createdId=await evaljs('location.pathname.split("/").at(-1)');
const created=await(await fetch(base+'/api/comprehensive-service-orders/'+createdId)).json();assert.equal(created.shippingOrders.length,3);assert.equal(created.selectableContainers.length,0);assert.equal(created.returnOrders.length,0);
await evaljs('[...document.querySelectorAll("button")].find(e=>e.textContent.includes("Заявки на вывоз - Авто")).click()');await pause(200);
assert.equal(await evaljs('!!document.querySelector(".service-pending-containers")'),false);
const layouts=[];for(const width of [1440,360]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(200);assert.equal(await evaljs('document.documentElement.scrollWidth>innerWidth+1'),false);layouts.push(width);fs.writeFileSync(path.join(dir,'../database/auto20-20261109-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
fs.writeFileSync(path.join(dir,'../database/auto20-20261109-ui.json'),JSON.stringify({database:session.database,createdId,shipping:created.shippingOrders.length,trainServiceWithThreeContainers:true,layouts},null,2));console.log('PASS browser creation, separate exports, no pending containers, layouts',layouts);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
