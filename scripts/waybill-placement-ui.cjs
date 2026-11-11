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
await wait('document.querySelector("tbody input[type=checkbox]")');
assert.equal(await evaljs('document.querySelectorAll(".placement-selection input:not([type=checkbox]),.placement-steps,.placement-subtitle").length'),0);
assert.deepEqual(await evaljs('[...document.querySelectorAll("thead th")].slice(1).map(el=>el.textContent)'),['Накладная','Кол-во вагонов','Кол-во КТК','Маршрут']);
assert.ok(await evaljs('[...document.querySelectorAll("tbody tr")].every(tr=>/^\\d+$/.test(tr.cells[2].textContent)&&/^\\d+$/.test(tr.cells[3].textContent))'));
await shot('selection');
// A shared wagon must show only the selected invoice and leave the other half free.
const scopeBill=fixture.bills[0].number;
for(let page=0;page<100;page++){
 const found=await evaljs('(()=>{const cb=[...document.querySelectorAll("tbody tr")].find(tr=>tr.cells[1]?.textContent==='+JSON.stringify(scopeBill)+')?.querySelector("input");if(cb){cb.click();return true}return false})()');
 if(found)break;
 assert.ok(!await evaljs('document.querySelector(".pagination button:last-child").disabled'),'Scope fixture not found');
 await evaljs('document.querySelector(".pagination button:last-child").click()');await wait('document.querySelector("tbody input[type=checkbox]")');
}
await evaljs('document.querySelector(".page-header .primary-button").click()');await wait('document.querySelector(".wagon-card")');
assert.equal(await evaljs('document.querySelectorAll(".wagon-card").length'),1);assert.equal(await evaljs('document.querySelectorAll(".ktk-unit").length'),1);
assert.equal(await evaljs('document.querySelectorAll(".wagon-other-load,.wagon-issue").length'),0);assert.equal(await evaljs('document.querySelectorAll(".wagon-free-slot").length'),1);
assert.ok(await evaljs('Math.abs(document.querySelector(".ktk-unit").getBoundingClientRect().width-document.querySelector(".wagon-free-slot").getBoundingClientRect().width)<1'));
console.log('PASS: only selected invoice shown; unselected KTK on the same wagon leave half of 80FT platform free');
await send('Page.navigate',{url:base+'/waybills/edit-placement'});await wait('document.querySelector("tbody input[type=checkbox]")');
const wanted=fixture.bills.map(b=>b.number);let selectedCount=0;
for(let page=0;page<100 && selectedCount<wanted.length;page++){
 selectedCount+=await evaljs('(()=>{const wanted='+JSON.stringify(wanted)+';let n=0;for(const tr of document.querySelectorAll("tbody tr")){if(wanted.includes(tr.cells[1]?.textContent)){const cb=tr.querySelector("input");if(!cb.checked){cb.click();n++}}}return n})()');
 if(selectedCount===wanted.length)break;
 assert.ok(!await evaljs('document.querySelector(".pagination button:last-child").disabled'),'Fixture not found');
 await evaljs('document.querySelector(".pagination button:last-child").click()');await wait('document.querySelector("tbody input[type=checkbox]")');
}
assert.equal(selectedCount,wanted.length);await evaljs('document.querySelector(".page-header .primary-button").click()');
await wait('document.querySelectorAll(".wagon-card").length===2');assert.equal(await evaljs('document.querySelectorAll(".ktk-unit").length'),4);
const groups=await evaljs('[...document.querySelectorAll(".wagon-card")].map(c=>({wagon:c.dataset.wagon,waybills:[...c.querySelectorAll(".ktk-unit")].map(r=>r.dataset.waybillId),rows:[...c.querySelectorAll(".ktk-unit")].map(r=>r.dataset.rowId)}))');
assert.equal(new Set(groups.map(g=>g.wagon)).size,2);assert.equal(new Set(groups.flatMap(g=>g.waybills)).size,4);assert.ok(groups.every(g=>g.rows.length===2&&new Set(g.waybills).size===2));
assert.equal(await evaljs('document.querySelectorAll(".wagon-other-load").length'),0);
assert.ok(await evaljs('[...document.querySelectorAll(".wagon-card")].every(c=>Math.abs(c.querySelector(".ktk-unit").getBoundingClientRect().width-c.querySelectorAll(".ktk-unit")[1].getBoundingClientRect().width)<1)'));
assert.ok(await evaljs('[...document.querySelectorAll(".wagon-card")].every(c=>new Set([...c.querySelectorAll(".ktk-waybill b")].map(b=>b.textContent)).size===2)'));
await shot('desktop');
const before=await evaljs('[...document.querySelectorAll(".ktk-unit")].map(el=>({id:el.dataset.rowId,wagon:el.dataset.wagonId,waybill:el.dataset.waybillId,text:el.textContent}))');
// Real HTML drag events through the browser mouse, not a direct state update.
const coords=await evaljs('(()=>{const cards=[...document.querySelectorAll(".wagon-card")];return [cards[0],cards.find(c=>c.dataset.wagon!==cards[0].dataset.wagon)].map(c=>{const r=c.querySelector(".ktk-box").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})})()');
await send('Input.dispatchMouseEvent',{type:'mouseMoved',...coords[0]});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...coords[0]});
for(let i=1;i<=15;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:coords[0].x+(coords[1].x-coords[0].x)*i/15,y:coords[0].y+(coords[1].y-coords[0].y)*i/15});await pause(25)}
await pause(200);await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...coords[1]});await pause(150);
await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...coords[1]});
await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Сохранить"&&!b.disabled)');
assert.equal(await evaljs('document.querySelectorAll(".ktk-unit").length'),4);
const after=await evaljs('[...document.querySelectorAll(".ktk-unit")].map(el=>({id:el.dataset.rowId,wagon:el.dataset.wagonId,waybill:el.dataset.waybillId,text:el.textContent}))');assert.equal(after.filter(a=>before.find(b=>b.id===a.id).wagon!==a.wagon).length,2);
assert.ok(after.every(a=>a.waybill===before.find(b=>b.id===a.id).waybill&&a.text===before.find(b=>b.id===a.id).text));
await click('Сохранить');await wait('document.querySelector(".placement-success")');
for(const row of after){const stored=execFileSync(process.env.DOCKER_EXE||'docker',['exec','billing-next-db-1','psql','-U','billing','-d',fixture.db,'-At','-c',"select rc.waybill_id||':'||rc.railway_carriage_id from waybill_container wc join waybill_railway_carriage rc on rc.id=wc.waybill_railway_carriage_id where wc.id='"+row.id+"'"],{encoding:'utf8',windowsHide:true}).trim();assert.equal(stored,row.waybill+':'+row.wagon);}
assert.ok(await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));
console.log('PASS: registry action, four waybill selection, two wagons, real mouse drag swap and database save');
// Moving within the same physical wagon must keep both waybill labels unchanged.
const same=await evaljs('(()=>{const a=document.querySelector(".wagon-card"),ktk=a.querySelectorAll(".ktk-unit"),center=el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};return {row:ktk[0].dataset.rowId,wagon:a.dataset.wagon,from:ktk[0].dataset.waybillId,coords:[center(ktk[0].querySelector(".ktk-box")),center(ktk[1].querySelector(".ktk-box"))]}})()');
await send('Input.dispatchMouseEvent',{type:'mouseMoved',...same.coords[0]});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...same.coords[0]});
for(let i=1;i<=20;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:same.coords[0].x+(same.coords[1].x-same.coords[0].x)*i/20,y:same.coords[0].y+(same.coords[1].y-same.coords[0].y)*i/20});await pause(25)}
await pause(150);await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...same.coords[1]});
assert.equal(await evaljs('document.querySelector('+JSON.stringify('[data-row-id="'+same.row+'"]')+').dataset.waybillId'),same.from);
assert.equal(await evaljs('document.querySelector('+JSON.stringify('[data-row-id="'+same.row+'"]')+').dataset.wagonId'),same.wagon);
assert.ok(await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));
console.log('PASS: dropping onto another KTK on the same physical wagon leaves the original waybill unchanged');
await evaljs('document.querySelector(".wagon-card .ktk-box").click()');await evaljs('[...document.querySelectorAll(".wagon-card")].find(c=>c.dataset.wagon!==document.querySelector(".wagon-card").dataset.wagon).querySelector(".wagon-target").click()');await wait('document.querySelector(".wagon-issue")');assert.ok(await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Сохранить").disabled'));
for(const width of [1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await pause(350);const sizes=await evaljs('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(sizes.scroll<=sizes.width,'Horizontal overflow '+JSON.stringify(sizes));if(width===360)await shot('mobile')}
assert.deepEqual(errors,[]);console.log('PASS: click placement, overload warning/disabled save, responsive widths 320–1440, no browser exceptions');await send('Browser.close');ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill()});