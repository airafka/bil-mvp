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
const docker=process.env.DOCKER_EXE||'docker',base='http://localhost:3196';
const inspected=JSON.parse(execFileSync(docker,['inspect','billing-next-storage-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(inspected.Config.Env.includes('DB_NAME=billing_storage_test'));
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
const go=async p=>{await send('Page.navigate',{url:base+p});await wait('document.querySelector("h1")?.textContent.includes("Хранение")');await pause(800)};
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,'../backups/'+name+'.png'),Buffer.from(r.data,'base64'))};
await go('/container-storage');await wait('document.querySelectorAll("tbody tr td").length>15');
assert.equal(await evaljs('document.querySelectorAll("thead th").length'),15);
const headers=await evaljs('[...document.querySelectorAll("thead th")].map(h=>h.textContent)');
for(const removed of ['В стоке','Площадка','Состояние','Клиент поставки','Собственник при приёме'])assert.ok(!headers.includes(removed));
for(const added of ['Клиент/собственник поставки','Клиент/собственник вывоза'])assert.ok(headers.includes(added));
assert.ok(await evaljs('[...document.querySelectorAll("tbody a")].filter(a=>a.pathname.includes("-orders/")).every(a=>/^[0-9]+$/.test(a.textContent))'));
const report=await (await fetch(base+'/api/container-storage-periods')).json();
const cells=await evaljs('[...document.querySelectorAll("tbody tr")].map(r=>[...r.cells].map(c=>c.textContent))');
const pair=(a,b)=>(a||'—')+' / '+(b||'—');
for(let i=0;i<report.items.length;i++){
 assert.equal(cells[i][5],pair(report.items[i].clientName,report.items[i].ownerName));
 assert.equal(cells[i][11],report.items[i].shippingOrderId?pair(report.items[i].shippingClientName,report.items[i].shippingOwnerName):'—');
}
assert.ok(await evaljs('[...document.querySelectorAll("tbody a")].some(a=>a.href.includes("receiving-orders"))'));
assert.ok(await evaljs('document.querySelector("a[href*=export]").href.includes("asOf=" )'));
for(const width of [1440,1024,640,360,320]) {
 await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(300);
 const dims=await evaljs('(()=>{const w=document.querySelector(".table-wrap");w.scrollLeft=100;return {body:document.documentElement.scrollWidth,screen:innerWidth,scroll:w.scrollLeft,headers:document.querySelectorAll("thead th").length}})()');
 assert.ok(dims.body<=width+1,JSON.stringify(dims));assert.ok(dims.scroll>0,JSON.stringify(dims));assert.equal(dims.headers,15);
}
await shot('storage-mobile');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await evaljs('document.querySelector(".table-wrap").scrollLeft=0');await pause(250);await shot('storage-desktop');
await evaljs('document.body.style.zoom="90%"');await pause(300);assert.ok(await evaljs('(()=>{const w=document.querySelector(".table-wrap");w.scrollLeft=500;return w.scrollLeft>0&&document.documentElement.scrollWidth<=innerWidth+1})()'));
await evaljs('document.body.style.zoom=""');
await go('/container-storage?query=NO-SUCH-STORAGE-CONTAINER');await wait('document.body?.textContent.includes("Периоды хранения не найдены")');
await go('/container-storage?status=invalid');await wait('document.querySelector("[role=alert]")');assert.match(await evaljs('document.querySelector("[role=alert]").textContent'),/состояние/);
await go('/container-storage?status=CANCELLED');await wait('document.querySelectorAll("tbody td").length>15');
assert.ok(await evaljs('[...document.querySelectorAll("tbody tr")].every(r=>r.cells[3].textContent.trim()==="—")'));
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../backups/storage-fixtures.json'),'utf8'));assert.equal(fixture.db,'billing_storage_test');
await send('Page.navigate',{url:base+'/container-owners/'+fixture.containerId+'/history'});await wait('document.body?.textContent.includes("Аннулирование вывоза")');
assert.ok(await evaljs('document.querySelector("a[href*=periodId]")!==null'));
await evaljs('document.querySelector("a[href*=periodId]").click()');await wait('document.body?.textContent.includes("Показан выбранный период")');await pause(600);
assert.equal(await evaljs('document.querySelectorAll("tbody tr").length'),1);
assert.equal(errors.length,0,JSON.stringify(errors));
console.log('PASS: storage UI, links, CSV action, empty/error/cancelled filters, history period link, 1440/1024/640/360/320 and 90% zoom; no browser exceptions');
ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
