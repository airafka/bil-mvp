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







const base=process.env.BILLING_UI_BASE||'http://localhost:3001';await send('Performance.enable');await send('Emulation.setCPUThrottlingRate',{rate:4});await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.navRequests=[];window.longTasks=[];new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});const native=window.fetch;window.fetch=async(...args)=>{if(args[1]?.method&&!['GET','HEAD'].includes(args[1].method.toUpperCase()))throw Error('Read only');const start=performance.now();const r=await native(...args);window.navRequests.push({url:String(args[0]),start,ms:performance.now()-start});return r}`});
await send('Page.navigate',{url:base+'/receiving-orders'});await wait('document.querySelector("main h1")&&!document.body.innerText.includes("Загружаем")');const results=[];
for(const [group,route] of [['Справочники','/waybills'],['Заявки','/comprehensive-service-orders'],['Биллинг','/billing-charges'],['Справочники','/containers'],['Заявки','/shipping-orders']]){
await evaljs('[...document.querySelectorAll(".nav-section-toggle")].find(b=>b.getAttribute("aria-label")==='+JSON.stringify(group)+').click()');await pause(300);const before=(await send('Performance.getMetrics')).metrics;await evaljs('window.navStart=performance.now();document.querySelector('+JSON.stringify('.nav-entry a[href="'+route+'"]')+').click()');await wait('location.pathname==='+JSON.stringify(route)+'&&document.querySelector("main h1")&&!document.body.innerText.includes("Загружаем")');await pause(300);const after=(await send('Performance.getMetrics')).metrics;const difference=name=>after.find(m=>m.name===name).value-before.find(m=>m.name===name).value;results.push({route,...await evaljs('({elapsed:performance.now()-window.navStart,requests:window.navRequests.filter(r=>r.start>=window.navStart),longTasks:window.longTasks.filter(r=>r.start>=window.navStart)})'),layoutCount:difference('LayoutCount'),layoutMs:difference('LayoutDuration')*1000,recalcCount:difference('RecalcStyleCount'),scriptMs:difference('ScriptDuration')*1000});}
fs.writeFileSync(path.join(dir,'../database/sidebar-performance-20261109-'+(process.argv.includes('--after')?'after':'before')+'.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({route,layoutCount,layoutMs,scriptMs,longTasks})=>({route,layoutCount,layoutMs,scriptMs,longTasks})),null,2));ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});