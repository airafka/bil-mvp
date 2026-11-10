const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=__dirname,profile=path.join(dir,'../backups/cancellation-ui-profile-'+Date.now());fs.mkdirSync(profile);
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








const {execFileSync}=require('node:child_process');const docker=process.env.DOCKER_EXE||'docker',base='http://localhost:3193';
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../backups/cancellation-fixtures.json'),'utf8'));
assert.equal(fixture.db,'billing_cancel_test');const inspected=JSON.parse(execFileSync(docker,['inspect','billing-next-cancellation-test'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(inspected.Config.Env.includes('DB_NAME='+fixture.db));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',fixture.db,'-At','-c',q],{encoding:'utf8',windowsHide:true}).trim();
async function api(p,method='GET',body){const r=await fetch(base+'/api'+p,{method,headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json()}
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
await send('Emulation.setFocusEmulationEnabled',{enabled:true});
const click=async(label,scope='document')=>{await evaljs('[...'+scope+'.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled).click()');await pause(60)};
const go=async(p)=>{await send('Page.navigate',{url:base+p});await wait('document.querySelector("h1")');await pause(250)};
const fill=async(text)=>{await evaljs('(()=>{const e=document.querySelector("dialog textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(text)+');e.dispatchEvent(new Event("input",{bubbles:true}))})()');await pause(70)};
const shot=async(name)=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,'../backups/'+name+'.png'),Buffer.from(r.data,'base64'))};
await go('/shipping-orders/'+fixture.uiDraft);await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Отменить заявку")');
await click('Отменить заявку');await wait('document.querySelector("dialog[open]")');
assert.equal(await evaljs('document.activeElement.tagName'),'TEXTAREA');assert.equal(await evaljs('document.querySelector("dialog button[type=submit]").disabled'),true);
for(const width of [1440,1024,640,360,320]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(200);
 const dimensions=await evaljs('(()=>{const d=document.querySelector("dialog"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:d.scrollWidth,client:d.clientWidth}})()');
 assert.ok(dimensions.left>=-1&&dimensions.right<=width+1,JSON.stringify(dimensions));assert.ok(dimensions.scroll<=dimensions.client+1,JSON.stringify(dimensions));
}
await shot('cancellation-dialog-mobile');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await pause(200);await shot('cancellation-dialog-desktop');
await fill('Отмена черновика через интерфейс');await click('Отменить заявку','document.querySelector("dialog")');await wait('!document.querySelector("dialog[open]")');await wait('document.querySelector(".status-badge[data-status=CANCELLED]")');
assert.equal((await api('/shipping-orders/'+fixture.uiDraft)).status,'CANCELLED');assert.equal(await evaljs('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Отменить заявку")'),false);
await wait('document.body.textContent.includes("Отмена черновика через интерфейс")');
console.log('PASS: cancellation UI, required reason, autofocus, 1440/1024/640/360/320 layouts, persisted status and reason');
const blocked=sql("select e.receiving_order_id from payment_invoice i join payment_invoice_line l on l.invoice_id=i.id join billing_charge b on b.id=l.billing_charge_id join service_execution e on e.id=b.service_execution_id where i.status='PAID' order by i.created_at desc limit 1");
await go('/receiving-orders/'+blocked);await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Отменить заявку")');await click('Отменить заявку');await wait('document.querySelector("dialog[open]")');await fill('Проверка блокировки счёта');await click('Отменить заявку','document.querySelector("dialog")');await wait('document.querySelector("dialog [role=alert]")');assert.match(await evaljs('document.querySelector("dialog [role=alert]").textContent'),/счета/);assert.equal((await api('/receiving-orders/'+blocked)).status,'COMPLETED');await shot('cancellation-invoice-error');
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector("dialog[open]")');
const source=await api('/shipping-orders/'+fixture.shipping),oldRoute=(await api('/routes/'+source.routeId)).route;
const created=await api('/routes','POST',{routeType:'SHIPPING',transportType:oldRoute.transportType,terminalAreaId:oldRoute.terminalAreaId,departureAt:new Date().toISOString(),carrierId:oldRoute.carrierId,driverId:oldRoute.driverId,vehicleId:oldRoute.vehicleId,orderIds:[]});
await go('/routes/'+created.route.id);await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Отменить рейс")');await click('Отменить рейс');await wait('document.querySelector("dialog[open]")');await fill('Отмена рейса через интерфейс');await click('Отменить рейс','document.querySelector("dialog")');await wait('document.querySelector(".status-badge[data-status=CANCELLED]")');assert.equal((await api('/routes/'+created.route.id)).route.status,'CANCELLED');
await go('/container-owners/'+fixture.container+'/history');await wait('document.querySelector("tbody")?.textContent.includes("Отмена:")');
assert.deepEqual(errors,[]);console.log('PASS: invoice conflict stays in form, Escape, route cancellation, marked KTK history, no browser exceptions');
await send('Browser.close');ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill()});
