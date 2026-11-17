const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=__dirname,profile=path.join(dir,'../backups/storage-ui-profile-'+Date.now());fs.mkdirSync(profile);
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









const {execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',base='http://localhost:3203';
const inspected=JSON.parse(execFileSync(docker,['inspect','billing-next-stock-history-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(inspected.Config.Env.includes('DB_NAME=billing_stock_history_test'));assert.ok(inspected.Config.Env.includes('FRONTEND_URL=http://localhost:3203'));
const ui=JSON.parse(execFileSync(docker,['inspect','billing-next-route-autofill-ui'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(ui.NetworkSettings.Ports['80/tcp'].some(p=>p.HostPort==='3203'));
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
async function api(p,method='GET',body,status=200){const r=await fetch(base+'/api'+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();assert.equal(r.status,status,t);return t?JSON.parse(t):null}
for(let i=0;i<50;i++){try{if((await fetch(base+'/actuator/health')).ok)break}catch{}await pause(200)}
const original=await api('/application-clock');
const setDate=async date=>{const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});await evaljs('window.dispatchEvent(new Event("focus"))');};
const nav=async p=>{await send('Page.navigate',{url:base+p});await wait('document.querySelector(".application-clock-trigger")');};
const click=selector=>evaljs('document.querySelector('+JSON.stringify(selector)+').click()');
const field='input[type="datetime-local"]';
const value=()=>evaljs('document.querySelector('+JSON.stringify(field)+')?.value');
const fill=async(selector,v)=>{await evaljs(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(i instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event(i instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);};
const button=text=>evaljs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getClientRects().length).click()`);
async function selectLabel(label,v){const selector=await evaljs(`(()=>{const s=[...document.querySelectorAll('label')].find(l=>l.querySelector('select')&&l.querySelector('span')?.textContent.includes(${JSON.stringify(label)})).querySelector('select');s.dataset.testField='select';return '[data-test-field="select"]'})()`);await fill(selector,v);await evaljs('delete document.querySelector("[data-test-field=select]").dataset.testField');}
try {
 await send('Emulation.setTimezoneOverride',{timezoneId:'America/Los_Angeles'});
 await setDate('2096-02-29');
 for(const p of ['/receiving-orders/new','/shipping-orders/new','/routes/new','/ui-kit']){
  await nav(p);await wait('document.querySelector("input[type=datetime-local]")?.value.startsWith("2096-02-29T")');
  console.log('PASS: working date in '+p);
 }
 await nav('/routes/new');await wait('document.querySelector("input[type=datetime-local]")');
 await setDate('2096-03-01');await wait('document.querySelector("input[type=datetime-local]").value.startsWith("2096-03-01T")');
 await fill(field,'2096-02-29T00:05');await setDate('2096-03-02');await wait('document.querySelector(".application-clock-trigger").textContent.includes("02.03.2096")');assert.equal(await value(),'2096-02-29T00:05');
 await fill(field,'');await setDate('2096-03-03');await wait('document.querySelector(".application-clock-trigger").textContent.includes("03.03.2096")');assert.equal(await value(),'');
 await fill(field,'2096-02-29T00:05');await wait('[...document.querySelectorAll("select")].some(s=>s.value&&s.textContent.includes("Контейнер"))');await selectLabel('Транспорт','RAILWAY');
 await button('Далее →');await wait('document.querySelector("button[form=route-create-form]") && !document.querySelector("button[form=route-create-form]").disabled');
 await click('button[type="submit"][form="route-create-form"]');
 await wait('location.pathname.startsWith("/routes/") && !location.pathname.endsWith("/new")');
 const routeId=await evaljs('location.pathname.split("/").at(-1)'),route=(await api('/routes/'+routeId)).route;
 assert.equal(Date.parse(route.departureAt),Date.parse('2096-02-28T21:05:00Z'));
 await wait('document.querySelector("[aria-label=Редактировать]")');await click('[aria-label="Редактировать"]');await wait('document.querySelector("input[type=datetime-local]")?.value==="2096-02-29T00:05"');await button('Отмена');
 console.log('PASS: untouched date follows calendar, manual/cleared values persist, route saves and edits Moscow time in a different browser time zone');
 await nav('/payment-invoices/new');await wait('document.querySelector("input[type=month]")?.value==="2096-03"');
 await nav('/comprehensive-service-orders/new');await wait('[...document.querySelectorAll(".ui-readonly-value")].some(n=>n.textContent==="03.03.2096")');
 // New service fixture exposes the route drawer in its shipping table.
 const catalog=(await api('/comprehensive-service-orders/available-services'))[0];
 const q=`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active and complex_service_id='${catalog.id}' order by id limit 1)t`;
 const tariff=JSON.parse(execFileSync(docker,['exec','billing-next-db-1','psql','-X','-U','billing','-d','billing_stock_history_test','-At','-c',q],{encoding:'utf8',windowsHide:true}));
 const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);
 const service=await api('/comprehensive-service-orders','POST',{complexServiceId:catalog.id,clientId:tariff.client_id,contractId:tariff.contract_id,defaultContainerOwnerId:tariff.client_id,waybillIds:[bill.id]},201);
 await nav('/comprehensive-service-orders/'+service.order.id);await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Заявки на вывоз"))');
 await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Заявки на вывоз")).click()');
 await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Создать рейс"&&!b.disabled)');await button('Создать рейс');
 await wait('document.querySelector("dialog[open] input[type=datetime-local]")?.value.startsWith("2096-03-03T")');await evaljs('[...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==="Автозаполнить").click()');
 await wait('[...document.querySelectorAll("dialog[open] select")].length===3 && [...document.querySelectorAll("dialog[open] select")].every(s=>s.value)');
 await click('[aria-label="Закрыть форму рейса"]');
 // Route picker in the manual order wizard.
 await nav('/receiving-orders/new');await wait('[...document.querySelectorAll("select")].some(s=>[...s.options].some(o=>o.value==="'+tariff.client_id+'"))');
 await selectLabel('Клиент',tariff.client_id);await wait('[...document.querySelectorAll("select")].some(s=>[...s.options].some(o=>o.value==="'+tariff.contract_id+'"))');
 await selectLabel('Договор',tariff.contract_id);await selectLabel('Вид транспорта','VEHICLE');await selectLabel('Собственник КТК',tariff.client_id);await button('Далее →');
 await wait('document.querySelector(".route-picker button")');await click('.route-picker button');
 await wait('document.querySelector(".route-picker-create input[type=datetime-local],.route-create-panel input[type=datetime-local],input[type=datetime-local]")?.value.startsWith("2096-03-03T")');
 assert.equal((await value()).slice(0,10),'2096-03-03');
 console.log('PASS: invoice month, service creation date, service route drawer and order route picker use working calendar');

 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k)));
 const carrier=catalogs[0].filter(x=>x.active).at(-1).id;
 await wait('document.querySelector(".route-picker-dialog select")&&!document.querySelector(".route-picker-dialog select").disabled');
 await fill('.route-picker-dialog select',carrier);
 const before=(await api('/routes')).length;
 await fill('.route-picker-dialog input[type=datetime-local]','');
 await evaljs('[...document.querySelectorAll(".route-picker-dialog button")].find(b=>b.textContent==="Автозаполнить").click()');
 await wait('[...document.querySelectorAll(".route-picker-dialog select")].every(s=>s.value) && document.querySelector(".route-picker-dialog input[type=datetime-local]").value.startsWith("2096-03-03T")');
 const selected=await evaljs('[...document.querySelectorAll(".route-picker-dialog select")].map(s=>s.value)');
 assert.equal(selected[0],carrier);assert.equal(selected[1],catalogs[1].find(x=>x.active).id);assert.equal(selected[2],catalogs[2].find(x=>x.active).id);
 assert.equal((await api('/routes')).length,before,'Autofill must not create a route');
 await send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:false});
 const bounds=await evaljs('[...document.querySelectorAll(".route-picker-dialog .header-actions button")].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right}})');
 assert.ok(bounds.every(r=>r.left>=0&&r.right<=321),JSON.stringify(bounds));
 const filledShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,'../backups/route-autofill-filled.png'),Buffer.from(filledShot.data,'base64'));
 await evaljs('[...document.querySelectorAll(".route-picker-dialog button")].find(b=>b.textContent==="Создать и выбрать").click()');
 await wait('!document.querySelector(".route-picker-dialog")');
 const after=await api('/routes');assert.equal(after.length,before+1);
 console.log('PASS: both route drawers autofill active catalog values, preserve manual choices, fill working date, fit 320px and only create on explicit save');
 assert.deepEqual(errors,[]);const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,'../backups/route-autofill-ui.png'),Buffer.from(shot.data,'base64'));
} catch(e) { console.error(await evaljs('document.body.innerText')); throw e; }
finally {const c=await api('/application-clock');await api('/application-clock','PUT',{date:original.mode==='SYSTEM'?null:original.date,version:c.version});ws.close();}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>chrome.kill());
