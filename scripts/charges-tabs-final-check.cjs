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








const {execFileSync}=require('child_process');const session=JSON.parse(fs.readFileSync(path.join(dir,'../database/return-progress-20261109-session.json'),'utf8').replace(/^\uFEFF/,''));assert.match(session.database,/^billing_next_return_progress_/);const info=JSON.parse(execFileSync('C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe',['inspect',session.backend],{windowsHide:true,encoding:'utf8'}))[0];assert.ok(info.Config.Env.includes('DB_NAME='+session.database));
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'../database/return-progress-20261109-check.json'),'utf8'));const base='http://localhost:3192';
await send('Page.addScriptToEvaluateOnNewDocument',{source:String.raw`
window.chargeRequests=[];window.chargeDelay=0;window.failNextCharge=false;const nativeFetch=window.fetch;window.fetch=async(...args)=>{const url=String(args[0]);if(url.includes('/api/billing-charges')){window.chargeRequests.push(url);if(window.chargeDelay)await new Promise(r=>setTimeout(r,window.chargeDelay));if(window.failNextCharge){window.failNextCharge=false;return new Response(JSON.stringify({detail:'Проверка повторной загрузки'}),{status:503,headers:{'Content-Type':'application/json'}})}}return nativeFetch(...args)}
`});
const click=async id=>evaljs('document.getElementById('+JSON.stringify(id)+').click()');
const geometry=()=>evaljs('(()=>{const panel=document.querySelector("[role=tabpanel]:not([hidden])"),t=panel.querySelector("table"),r=t.parentElement.getBoundingClientRect(),h=t.querySelector("th"),bar=document.querySelector(".service-tabs-toolbar").getBoundingClientRect();return {top:r.top,left:r.left,width:r.width,gap:r.top-bar.bottom,headers:[...t.tHead.rows[0].cells].map(c=>c.textContent),columns:[...t.tHead.rows[0].cells].map(c=>c.getBoundingClientRect().width),font:getComputedStyle(h).fontSize,padding:getComputedStyle(h).padding,background:getComputedStyle(h).backgroundColor,layout:getComputedStyle(t).tableLayout,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+fixture.mixed});await wait('document.querySelector("#service-charges .table-wrap[aria-busy=false]")');await evaljs('window.keptTable=document.querySelector(".service-charge-table");void 0');
const layouts=[];for(const width of [1440,1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await pause(300);await click('service-tab-returns');await pause(100);const returns=await geometry();await click('service-tab-charges');const first=await geometry();await pause(100);const settled=await geometry();assert.deepEqual(first.headers,['№','Дата оказания','КТК','Без НДС, ₽','С НДС, ₽']);assert.equal(first.layout,'fixed');for(const key of ['top','left','width','gap','padding','font','background'])assert.equal(first[key],returns[key],width+' '+key);assert.deepEqual(first.columns,settled.columns,'No delayed column resize');assert.equal(first.overflow,false);assert.equal(await evaljs('window.keptTable===document.querySelector(".service-charge-table")'),true);layouts.push({width,returns,charges:first});if([1440,360].includes(width))fs.writeFileSync(path.join(dir,'../database/charges-tabs-20261109-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
assert.equal(await evaljs('window.chargeRequests.length'),1,'Prefetch once; switching must not fetch again');
await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.failNextCharge=true'});
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+fixture.mixed});await wait('document.querySelector("#service-charges .table-wrap[aria-busy=false]")');assert.equal(await evaljs('!!document.querySelector(".notification-error")'),false,'Prefetch error must stay hidden with its tab');await click('service-tab-charges');await wait('document.querySelector(".notification-error")');await evaljs('[...document.querySelectorAll("button")].find(b=>b.textContent==="Повторить").click()');await wait('document.querySelector("#service-charges .table-wrap[aria-busy=false]")&&!document.querySelector(".notification-error")');
fs.writeFileSync(path.join(dir,'../database/charges-tabs-20261109-final.json'),JSON.stringify({database:session.database,layouts,requestsForFiveSwitches:1,hiddenErrorAndRetryPassed:true},null,2));console.log('PASS final layout, request count, hidden error and retry');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
