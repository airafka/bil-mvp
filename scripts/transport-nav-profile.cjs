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








const base=process.env.BILLING_UI_BASE||'http://localhost:3001',tag=process.env.BILLING_REPORT||'before';await send('Emulation.setFocusEmulationEnabled',{enabled:true});await send('Emulation.setCPUThrottlingRate',{rate:4});await send('Page.navigate',{url:base+'/receiving-orders'});await wait('document.querySelector(".transport-order-registry tbody .order-code")');await pause(300);await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:500});await send('Profiler.start');
for(const route of ['/shipping-orders','/receiving-orders','/shipping-orders','/receiving-orders']){await evaljs('document.querySelector(\'.nav-section-toggle[aria-label="Заявки"]\').click()');await pause(300);await evaljs('document.querySelector('+JSON.stringify('.nav-entry a[href="'+route+'"]')+').click()');await wait('location.pathname==='+JSON.stringify(route)+'&&document.querySelector(".table-card")?.getAttribute("aria-busy")==="false"');await pause(300)}
const {profile:cpuProfile}=await send('Profiler.stop');fs.writeFileSync(path.join(dir,'../database/transport-nav-profile-'+tag+'.json'),JSON.stringify(cpuProfile));const counts=new Map();for(let i=0;i<cpuProfile.samples.length;i++){const id=cpuProfile.samples[i];counts.set(id,(counts.get(id)||0)+cpuProfile.timeDeltas[i]);}const stats=cpuProfile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,column:n.callFrame.columnNumber,ms:(counts.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,22);console.log(JSON.stringify(stats,null,2));ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
