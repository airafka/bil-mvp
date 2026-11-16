const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=__dirname,profile=path.join(dir,'../backups/no-return-ui-profile-'+Date.now());fs.mkdirSync(profile);
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

const {execFileSync}=require('node:child_process'),base='http://localhost:3195';
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../backups/no-return-fixture.json'),'utf8'));
assert.equal(fixture.db,'billing_no_return_test');
const docker=process.env.DOCKER_EXE||'docker';
const inspected=JSON.parse(execFileSync(docker,['inspect','billing-next-no-return-test'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(inspected.Config.Env.includes('DB_NAME='+fixture.db));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',fixture.db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();
assert.equal(sql('select current_database()'),fixture.db);
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
const click=async(label)=>{await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled).click()');await pause(100)};
const shot=async(name)=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(dir,'../backups/no-return-'+name+'.png'),Buffer.from(r.data,'base64'))};
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+fixture.service});await wait('document.querySelector("#service-tab-shipping")');await evaljs('document.querySelector("#service-tab-shipping").click()');
await click('Возврат не нужен');await wait('document.querySelectorAll("dialog[open] tbody tr").length===2');
assert.ok(await evaljs('document.querySelector("dialog[open] button[type=submit]").disabled'));
assert.ok(await evaljs('document.querySelector("dialog[open]").contains(document.activeElement)'));
await shot('desktop');
for(const width of [1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(300);await shot('width-'+width);assert.ok(await evaljs('document.documentElement.scrollWidth<=innerWidth'),'Page overflow at '+width);assert.ok(await evaljs('document.querySelector("dialog[open]").scrollWidth<=document.querySelector("dialog[open]").clientWidth'),'Dialog overflow at '+width);if(width===320)await shot('mobile')}
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector("dialog[open]")');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await click('Возврат не нужен');await wait('document.querySelectorAll("dialog[open] tbody tr").length===2');
await evaljs('document.querySelector("dialog[open] thead input").click()');
assert.equal(await evaljs('document.querySelectorAll("dialog[open] tbody input:checked").length'),2);
await evaljs('document.querySelector("dialog[open] tbody input").click()');assert.ok(await evaljs('document.querySelector("dialog[open] thead input").indeterminate'));
await evaljs('document.querySelector("dialog[open] thead input").click()');
await evaljs('document.querySelector("dialog[open] button[type=submit]").click()');await wait('!document.querySelector("dialog[open]")');
assert.equal(sql("select count(*) from service_execution where comprehensive_service_order_id='"+fixture.service+"'"),'1','only completed shipment charged');
await shot('saved');
await evaljs('document.body.style.zoom="0.9"');await pause(300);assert.ok(await evaljs('document.documentElement.scrollWidth<=innerWidth'),'Page overflow at 90%');await evaljs('document.body.style.zoom=""');
await evaljs('document.querySelector("#service-tab-charges").click()');await wait('document.querySelectorAll("#service-panel-charges tbody tr td").length===5');
assert.ok(await evaljs('document.querySelector("#service-panel-charges tbody").textContent.includes('+JSON.stringify(fixture.containers.find(c=>c.id===sql("select container_id from shipping_order_container where shipping_order_id='"+fixture.shipping[0]+"'" )).name)+')'));
await evaljs('document.querySelector("#service-tab-shipping").click()');
await click('Возврат не нужен');await wait('document.querySelectorAll("dialog[open] tbody input:checked:disabled").length===2');assert.ok(await evaljs('document.querySelector("dialog[open] button[type=submit]").disabled'));
await evaljs('document.querySelector("dialog[open] .close-button").click()');
await click('Создать возврат');await wait('document.querySelector(".notification-error")');assert.ok(!await evaljs('document.querySelector("dialog[open]")'));
console.log('PASS: dialog, keyboard close, select all/partial, persistent markings, immediate charge only for completed shipping, empty return choice, responsive 320–1440');
// Direct shipment form excludes no-return KTK as well.
await send('Page.navigate',{url:base+'/shipping-orders/'+fixture.shipping[0]});await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Создать возврат")');await click('Создать возврат');await wait('document.querySelector("dialog[open]")?.textContent.includes("Нет КТК для возврата")');await evaljs('document.querySelector("dialog[open] .close-button").click()');
// The ordinary direct return dialog still loads selectable KTK after its eligibility request.
const ordinary=await(await fetch('http://127.0.0.1:8195/api/comprehensive-service-orders/'+fixture.otherService)).json();
await send('Page.navigate',{url:base+'/shipping-orders/'+ordinary.shippingOrders[0].id});await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Создать возврат")');await click('Создать возврат');await wait('document.querySelector("dialog[open] tbody input")');assert.ok(await evaljs('document.querySelector("dialog[open] tbody input").checked'));await evaljs('document.querySelector("dialog[open] .close-button").click()');
// Stale selection must show an error without losing checked containers.
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+fixture.otherService});await wait('document.querySelector("#service-tab-shipping")');await evaljs('document.querySelector("#service-tab-shipping").click()');await click('Возврат не нужен');await wait('document.querySelector("dialog[open] tbody input")');await evaljs('document.querySelector("dialog[open] tbody input").click()');
const other=await(await fetch('http://127.0.0.1:8195/api/comprehensive-service-orders/'+fixture.otherService)).json();
const response=await fetch('http://127.0.0.1:8195/api/comprehensive-service-orders/'+fixture.otherService+'/returns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({containerIds:[other.receivingOrder.containers[0].containerId],useCurrentClient:true})});assert.equal(response.status,201);
await evaljs('document.querySelector("dialog[open] button[type=submit]").click()');await wait('document.querySelector("dialog[open] [role=alert]")');assert.ok(await evaljs('document.querySelector("dialog[open] tbody input").checked'));await shot('conflict');
assert.deepEqual(errors,[]);console.log('PASS: direct shipment return eligibility, stale-choice error preserves selection, no browser exceptions');
await send('Browser.close');ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill()});
