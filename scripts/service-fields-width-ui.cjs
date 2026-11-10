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









const base=process.env.BILLING_UI_BASE||'http://localhost:3192';assert.ok(['http://localhost:3192','http://localhost:3001'].includes(base));const label=base.endsWith('3192')?'test':'live';
const contracts=await(await fetch(base+'/api/references/contracts')).json();assert.ok(contracts.length>0);assert.ok(contracts.every(c=>c.validFrom==='2026-01-01'));
const tariffContracts=await(await fetch(base+'/api/references/contracts?activeTariffsOnly=true')).json();assert.ok(tariffContracts.length>0);assert.ok(tariffContracts.every(c=>c.validFrom==='2026-01-01'));
await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.blockedWrites=[];const old=window.fetch;window.fetch=(url,init)=>{if(init?.method&&!['+JSON.stringify('GET')+','+JSON.stringify('HEAD')+'].includes(init.method.toUpperCase())){window.blockedWrites.push(String(url));throw Error("Read only verification")}return old(url,init)}'});
await send('Page.navigate',{url:base+'/comprehensive-service-orders/new'});await wait('document.querySelector(".service-order-main-grid select")?.options.length>1&&!document.querySelector(".service-order-main-grid select").disabled');
const fields=()=>evaljs('[...document.querySelectorAll(".service-order-main-grid > .form-fields-column")].map(col=>[...col.querySelectorAll(".field > span:first-child")].map(e=>e.textContent.replace(/[:*]/g,"").trim()))');
assert.deepEqual(await fields(),[['Номер заявки','Дата создания','Клиент','Договор','Услуга','Собственник КТК'],['Вид договора','Действует с','Статус']]);
assert.equal(await evaljs('[...document.querySelectorAll("h2")].some(e=>e.textContent==="Накладные ЭТРАН")'),true);
assert.equal(await evaljs('document.body.textContent.includes("Отбор накладных ЭТРАН")'),false);
const valueExpr=name=>'[...document.querySelectorAll(".service-order-main-grid .field")].find(e=>e.querySelector("span")?.textContent.startsWith('+JSON.stringify(name+':')+'))';
const change=async(name,value)=>{await evaljs('(()=>{const e='+valueExpr(name)+'.querySelector("select");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');await pause(60);};
const textValue=name=>evaljs(valueExpr(name)+'.querySelector(".ui-readonly-value").textContent');
assert.equal(await textValue('Дата создания'),new Date().toLocaleDateString('ru-RU', {timeZone:'Europe/Moscow'}));
assert.equal(await evaljs(valueExpr('Дата создания')+'.querySelector("input")'),null);
assert.equal(await textValue('Действует с'),'Выберите договор');
const first=tariffContracts[0],second=tariffContracts.find(c=>c.clientId!==first.clientId);assert.ok(second);
await change('Клиент',first.clientId);await change('Договор',first.id);assert.equal(await textValue('Действует с'),'01.01.2026');assert.equal(await textValue('Вид договора'),first.contractType);
assert.equal(await evaljs('document.querySelector(\'select[aria-label="Собственник КТК"]\').value'),first.clientId);
await change('Собственник КТК',second.clientId);await change('Договор',first.id);assert.equal(await evaljs('document.querySelector(\'select[aria-label="Собственник КТК"]\').value'),second.clientId);
await change('Клиент',second.clientId);assert.equal(await textValue('Действует с'),'Выберите договор');await change('Договор',second.id);assert.equal(await textValue('Действует с'),'01.01.2026');
await change('Клиент',first.clientId);await change('Договор',first.id);
const serviceId=await evaljs('(()=>{const e='+valueExpr('Услуга')+'.querySelector("select"),c=document.createElement("canvas").getContext("2d");c.font=getComputedStyle(e).font;return [...e.options].filter(o=>o.value).sort((a,b)=>c.measureText(b.textContent).width-c.measureText(a.textContent).width)[0].value})()');await change('Услуга',serviceId);
const alignedFields=async()=>{const bounds=await evaljs('[...document.querySelectorAll(".service-order-main-grid > .form-fields-column:first-child > .horizontal-field > :last-child")].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}})');assert.equal(bounds.length,6);for(const b of bounds){assert.ok(Math.abs(b.left-bounds[0].left)<0.1);assert.ok(Math.abs(b.right-bounds[0].right)<0.1);assert.ok(b.width<=504.1);}return bounds;};
const layouts=[];for(const width of [1440,1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await pause(250);
const layout=await evaljs('(()=>{const grid=document.querySelector(".service-order-main-grid"),cols=[...grid.children].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,bottom:r.bottom}});return {overflow:document.documentElement.scrollWidth>innerWidth+1,cols,inputs:[...grid.querySelectorAll("select")].map(e=>e.getBoundingClientRect().height),date:'+valueExpr('Действует с')+'.textContent}})()');
assert.equal(layout.overflow,false,'Page overflow at '+width);assert.ok(layout.inputs.every(h=>h>=39.5));if(width===1440){assert.ok(layout.cols[1].x>layout.cols[0].x+layout.cols[0].width-1);const geometry=await evaljs('(()=>{const e='+valueExpr('Услуга')+'.querySelector("select"),s=getComputedStyle(e),c=document.createElement("canvas").getContext("2d");c.font=s.font;return {width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,room:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-Math.max(...[...e.options].map(o=>c.measureText(o.textContent).width))}})()');assert.equal(geometry.width,504);assert.equal(geometry.height,40);assert.ok(geometry.room>=8);layout.service=geometry;}if(width<=640)assert.ok(layout.cols[1].y>=layout.cols[0].bottom-1);layout.alignedFields=await alignedFields();layouts.push({width,...layout});
if([1440,360].includes(width))fs.writeFileSync(path.join(dir,'../database/service-fields-width-'+label+'-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
assert.deepEqual(await evaljs('window.blockedWrites'),[]);
await send('Page.navigate',{url:base+'/receiving-orders/new'});await wait('[...document.querySelectorAll("label.field")].some(e=>e.textContent.startsWith("Номер заявки:"))');
assert.equal(await evaljs('document.body.textContent.includes("Собственник КТК по умолчанию:")'),true);assert.equal(await evaljs('document.body.textContent.includes("Действует с:")'),false);
assert.deepEqual(await evaljs('window.blockedWrites'),[]);
fs.writeFileSync(path.join(dir,'../database/service-fields-width-'+label+'-ui.json'),JSON.stringify({base,contractCount:contracts.length,tariffContractCount:tariffContracts.length,layouts,checks:['field order','contract date and type','client change clears contract date','owner autofill and manual override','ordinary receiving form preserved','no writes']},null,2));
console.log('PASS contract form, all '+contracts.length+' contract dates, 5 viewport sizes, no writes');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
