const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const dir=__dirname,profile=path.join(dir,'../backups/wagon-length-ui-profile-'+Date.now());fs.mkdirSync(profile);
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
let port;for(let i=0;i<80;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await pause(100)}assert.ok(port,'Headless browser startup');
const browserTarget=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');const ws=new WebSocket(browserTarget.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)}});
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,{resolve:r=>{clearTimeout(timeout);resolve(r)},reject:e=>{clearTimeout(timeout);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaljs(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression){for(let i=0;i<70;i++){if(await evaljs('Boolean('+expression+')'))return;await pause(100)}throw Error('Timeout: '+expression)}
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});

const {execFileSync}=require('node:child_process'),base='http://localhost:3194';
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../backups/wagon-length-fixtures.json'),'utf8'));
assert.equal(fixture.db,'billing_wagon_test');const inspected=JSON.parse(execFileSync(process.env.DOCKER_EXE||'docker',['inspect','billing-next-wagon-test'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(inspected.Config.Env.includes('DB_NAME='+fixture.db));
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
const click=async(label)=>{await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled).click()');await pause(100)};
const shot=async(name)=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(dir,'../backups/wagon-compact-'+name+'.png'),Buffer.from(r.data,'base64'))};
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:base+'/waybills/edit-placement'});await wait('document.querySelector(".placement-selection input")');
await wait('document.querySelector("tbody input[type=checkbox]")');
assert.equal(await evaljs('document.querySelectorAll(".placement-selection input:not([type=checkbox]),.placement-steps,.placement-subtitle").length'),0);
assert.deepEqual(await evaljs('[...document.querySelectorAll("thead th")].slice(1).map(el=>el.textContent)'),['Накладная','Кол-во вагонов','Кол-во КТК','Маршрут']);
assert.ok(await evaljs('[...document.querySelectorAll("tbody tr")].every(tr=>/^\\d+$/.test(tr.cells[2].textContent)&&/^\\d+$/.test(tr.cells[3].textContent))'));
await shot('selection');
const wanted=fixture.bills.map(b=>b.number);let selectedCount=0;
for(let page=0;page<100 && selectedCount<wanted.length;page++){
 selectedCount+=await evaljs('(()=>{const wanted='+JSON.stringify(wanted)+';let n=0;for(const tr of document.querySelectorAll("tbody tr")){if(wanted.includes(tr.cells[1]?.textContent)){const cb=tr.querySelector("input");if(!cb.checked){cb.click();n++}}}return n})()');
 if(selectedCount===wanted.length)break;
 assert.ok(!await evaljs('document.querySelector(".pagination button:last-child").disabled'),'Fixture not found');
 await evaljs('document.querySelector(".pagination button:last-child").click()');await wait('document.querySelector("tbody input[type=checkbox]")');
}
assert.equal(selectedCount,wanted.length);await evaljs('document.querySelector(".page-header .primary-button").click()');
await wait('document.querySelectorAll(".wagon-card").length===4');
assert.equal(await evaljs('document.querySelectorAll(".placement-steps,.placement-toolbar,.placement-help,.placement-add,input:not([type=checkbox]),select").length'),0);
const card=id=>'document.querySelector('+JSON.stringify('[data-wagon="'+id+'"]')+')';
const target=card(fixture.target),count=()=>evaljs(target+'.querySelectorAll(".ktk-unit").length');assert.equal(await count(),6);
assert.ok(await evaljs('[...document.querySelectorAll(".wagon-card")].every(el=>el.getBoundingClientRect().top===document.querySelector(".wagon-card").getBoundingClientRect().top)'));
assert.equal(await evaljs('new Set([...document.querySelectorAll(".ktk-box")].map(el=>getComputedStyle(el).backgroundImage)).size'),1);
assert.ok(await evaljs('[...document.querySelectorAll(".wagon-caption")].every(el=>/^№[0-9]+[(](?:40|60|80)FT[)]$/.test(el.textContent))'));
assert.ok(await evaljs('[...document.querySelectorAll(".ktk-box")].every(el=>/^(?:20|40)FT[A-Z0-9]+$/.test(el.textContent))'));
assert.equal(await evaljs('document.querySelectorAll(".wagon-meta,.ktk-topline,.ktk-bottomline").length'),0);
const width=()=>evaljs(target+'.querySelector(".ktk-box").getBoundingClientRect().width');const sixWidth=await width();let previousWidth=sixWidth;await shot('six');
for(let i=0;i<2;i++){
 const coords=await evaljs('['+target+'.querySelector(".ktk-box"),'+card(fixture.empty[i])+'.querySelector(".wagon-empty-slot")].map(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})');
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...coords[0]});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...coords[0]});
 for(let j=1;j<=15;j++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:coords[0].x+(coords[1].x-coords[0].x)*j/15,y:coords[0].y+(coords[1].y-coords[0].y)*j/15});await pause(25)}
 await pause(200);await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...coords[1]});await pause(150);
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...coords[1]});await wait(target+'.querySelectorAll(".ktk-unit").length==='+String(5-i));
 const currentWidth=await width();assert.ok(currentWidth>previousWidth);previousWidth=currentWidth;if(i===0){assert.ok(await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));await shot('five')}
}
assert.ok(!await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));await shot('four');await click('Сохранить');await wait('document.querySelector(".placement-success")');
console.log('PASS: four wagons in one row, single blue palette, minimal labels, six visible containers, real drag 6→5→4 with increasing size, length validation and save');
for(const width of [1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await pause(300);const sizes=await evaljs('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(sizes.scroll<=sizes.width,'Horizontal overflow '+JSON.stringify(sizes));if(width===360)await shot('mobile')}
assert.deepEqual(errors,[]);console.log('PASS: responsive 320–1440, no browser exceptions');await send('Browser.close');ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill()});
