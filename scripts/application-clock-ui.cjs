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
const docker=process.env.DOCKER_EXE||'docker',base='http://localhost:3199';
const inspected=JSON.parse(execFileSync(docker,['inspect','billing-next-clock-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(inspected.Config.Env.includes('DB_NAME=billing_clock_test'));
assert.ok(inspected.Config.Env.includes('FRONTEND_URL=http://localhost:3199'));
assert.ok(inspected.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8199'));
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../backups/clock-fixture.json'),'utf8'));assert.equal(fixture.db,'billing_clock_test');
const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
const api=async()=>await(await fetch(base+'/api/application-clock')).json();
const setDate=async date=>{const s=await api();const r=await fetch(base+'/api/application-clock',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,version:s.version})});assert.equal(r.status,200);return r.json()};
const click=async selector=>await evaljs('document.querySelector('+JSON.stringify(selector)+').click()');
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,'../backups/'+name+'.png'),Buffer.from(r.data,'base64'))};
try {
 await setDate('2096-02-28');
 await send('Page.navigate',{url:base+'/container-storage?periodId='+fixture.periodId});
 await wait('document.querySelector(".application-clock-trigger")?.textContent.includes("28.02.2096")');
 await wait('document.querySelector("tbody tr[data-period-id]")?.cells[3]?.textContent.trim()==="1"');
 await click('.application-clock-trigger');await wait('document.querySelector(".application-calendar").matches(":popover-open")');
 await click('[aria-label="Следующий день"]');
 await wait('document.querySelector(".application-clock-trigger").textContent.includes("29.02.2096")');
 await wait('document.querySelector("tbody tr[data-period-id]")?.cells[3]?.textContent.trim()==="2"');
 await click('[aria-label="Предыдущий день"]');
 await wait('document.querySelector(".application-clock-trigger").textContent.includes("28.02.2096")');
 // Native date field through the real React input handler.
 await evaljs('(()=>{const i=document.querySelector(".application-calendar input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,"2096-03-05");i.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await wait('document.querySelector(".application-calendar input").value==="2096-03-05"');
 await click('.application-calendar button[type=submit]');
 await wait('document.querySelector(".application-clock-trigger").textContent.includes("05.03.2096")');
 await wait('document.querySelector("tbody tr[data-period-id]")?.cells[3]?.textContent.trim()==="5"');
 await send('Page.reload');await wait('document.querySelector(".application-clock-trigger")?.textContent.includes("05.03.2096")');
 await send('Page.navigate',{url:base+'/comprehensive-service-orders/new'});
 await wait('[...document.querySelectorAll(".ui-readonly-value")].some(n=>n.textContent==="05.03.2096")');
 await send('Page.navigate',{url:base+'/payment-invoices/new'});
 await wait('document.querySelector("input[type=month]")?.value==="2096-03"');
 await send('Page.navigate',{url:base+'/container-storage?periodId='+fixture.periodId});
 await wait('document.querySelector("tbody tr[data-period-id]")?.cells[3]?.textContent.trim()==="5"');
 await click('.application-clock-trigger');await wait('document.querySelector(".application-calendar").matches(":popover-open")');
 for(const [width,height] of [[1440,1000],[1024,768],[640,700],[360,740],[320,700]]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  // Reopen to anchor to the resized header.
  await click('.application-clock-trigger');await click('.application-clock-trigger');await pause(700);
  const g=await evaljs('(()=>{const p=document.querySelector(".application-calendar").getBoundingClientRect(),t=document.querySelector(".application-clock-trigger").getBoundingClientRect(),w=document.querySelector(".table-wrap");return {left:p.left,right:p.right,bottom:p.bottom,trigger:t.right,width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,tableHeight:w.clientHeight,rows:w.scrollHeight}})()');
  assert.ok(g.left>=0&&g.right<=width+1&&g.bottom<=height+1,JSON.stringify(g));assert.ok(g.trigger<=width&&g.pageWidth<=width+1&&g.pageHeight<=height+1,JSON.stringify(g));assert.ok(g.rows<=g.tableHeight+1,JSON.stringify(g));
  if(width===1440||width===320)await shot('clock-'+width);
 }
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await wait('!document.querySelector(".application-calendar").matches(":popover-open")');
 await click('.application-clock-trigger');
 await evaljs('[...document.querySelectorAll(".application-calendar button")].find(b=>b.textContent==="Сегодня").click()');
 await wait('document.querySelector(".application-clock-trigger").dataset.mode==="SYSTEM"');
 assert.equal((await api()).mode,'SYSTEM');assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('PASS: calendar input, leap-day arrows, live storage recalculation, reload persistence, creation date and invoice month, Today, Escape, 1440/1024/640/360/320 layouts, no browser exceptions');
} catch(e) { console.error(await evaljs('document.body.innerText'));console.error(await api());await shot('clock-failure');throw e;} finally {await setDate(null);ws.close();chrome.kill();}
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
