const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=__dirname,profile=path.join(dir,'../backups/wagon-ui-profile-'+Date.now());fs.mkdirSync(profile);
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
const {execFileSync}=require('node:child_process'),base='http://localhost:3194';
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../backups/wagon-fixtures.json'),'utf8'));
assert.equal(fixture.db,'billing_wagon_test');
const inspected=JSON.parse(execFileSync(process.env.DOCKER_EXE||'docker',['inspect','billing-next-wagon-test'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(inspected.Config.Env.includes('DB_NAME='+fixture.db));
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
const click=async(label)=>{await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled).click()');await pause(100)};
const shot=async(name)=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(dir,'../backups/wagon-'+name+'.png'),Buffer.from(r.data,'base64'))};
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:base+'/waybills'});await wait('document.querySelector("a[href$=edit-placement]")');await evaljs('document.querySelector("a[href$=edit-placement]").click()');await wait('document.querySelector(".placement-selection input")');
await evaljs(`(()=>{const el=document.querySelector('.placement-selection input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(fixture.tag)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await wait('document.querySelectorAll("tbody input[type=checkbox]").length===4');await evaljs('document.querySelector("thead input[type=checkbox]").click()');await click('Показать вагоны →');await wait('document.querySelectorAll(".wagon-card").length===2');assert.equal(await evaljs('document.querySelectorAll(".ktk-unit").length'),4);
await shot('desktop');
const before=await evaljs('[...document.querySelectorAll(".ktk-unit")].map(el=>({id:el.dataset.rowId,wagon:el.dataset.wagonId,text:el.textContent}))');
// Real HTML drag events through the browser mouse, not a direct state update.
const coords=await evaljs('(()=>{const cards=[...document.querySelectorAll(".wagon-card")];return cards.map(c=>{const r=c.querySelector(".ktk-box").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})})()');
await send('Input.dispatchMouseEvent',{type:'mouseMoved',...coords[0]});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...coords[0]});
for(let i=1;i<=15;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:coords[0].x+(coords[1].x-coords[0].x)*i/15,y:coords[0].y+(coords[1].y-coords[0].y)*i/15});await pause(25)}
await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...coords[1]});
await wait('document.querySelector(".placement-changed").textContent.includes("2")');
const after=await evaljs('[...document.querySelectorAll(".ktk-unit")].map(el=>({id:el.dataset.rowId,wagon:el.dataset.wagonId}))');assert.equal(after.filter(a=>before.find(b=>b.id===a.id).wagon!==a.wagon).length,2);
await click('Сохранить');await wait('document.querySelector(".placement-success")');assert.ok(await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));
console.log('PASS: registry action, four waybill selection, two wagons, real mouse drag swap and database save');
await evaljs('document.querySelector(".wagon-card .ktk-box").click()');await evaljs('[...document.querySelectorAll(".wagon-card")][1].querySelector(".secondary-button").click()');await wait('document.querySelector(".wagon-issue")');assert.ok(await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));await click('Сбросить перемещения');
for(const width of [1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await pause(350);const sizes=await evaljs('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(sizes.scroll<=sizes.width,'Horizontal overflow '+JSON.stringify(sizes));if(width===360)await shot('mobile')}
assert.deepEqual(errors,[]);console.log('PASS: click placement, overload warning/disabled save, reset, responsive widths 320–1440, no browser exceptions');await send('Browser.close');ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill()});