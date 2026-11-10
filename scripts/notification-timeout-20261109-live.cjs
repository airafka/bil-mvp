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









const errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
await send('Page.addScriptToEvaluateOnNewDocument',{source:
'window.notificationEvents=[];window.writes=[];const seen=new Map();const sample=()=>{for(const e of document.querySelectorAll(".notification-card")){if(!seen.has(e)){const row={kind:e.classList.contains("notification-success")?"success":"error",shown:performance.now()};seen.set(e,row);window.notificationEvents.push(row)}}for(const [e,row]of seen){if(!e.isConnected&&!row.hidden)row.hidden=performance.now()}};new MutationObserver(sample).observe(document,{childList:true,subtree:true});history.replaceState({...history.state,usr:{createdCode:999999}},"");const original=window.fetch;window.fetch=(url,init)=>{if(init?.method&&!["GET","HEAD"].includes(init.method.toUpperCase())){window.writes.push(String(url));throw Error("Read only verification")}if(String(url).includes("/api/receiving-orders?"))return new Promise(r=>setTimeout(()=>r(new Response(JSON.stringify({message:"Проверка скрытия уведомления"}),{status:500,headers:{"Content-Type":"application/json"}})),1000));return original(url,init)}'
});
await send('Page.navigate',{url:'http://localhost:3001/receiving-orders'});await wait('document.querySelector(".notification-success")');await wait('document.querySelector(".notification-error")');await pause(900);assert.equal(await evaljs('document.querySelectorAll(".notification-card").length'),2);
await wait('window.notificationEvents.length===2&&window.notificationEvents.every(e=>e.hidden)');const automatic=await evaljs('window.notificationEvents.map(e=>({...e,duration:e.hidden-e.shown}))');assert.ok(automatic.every(e=>e.duration>=2900&&e.duration<3500),JSON.stringify(automatic));assert.deepEqual(await evaljs('window.writes'),[]);
await send('Page.navigate',{url:'http://localhost:3001/receiving-orders'});await wait('document.querySelector(".notification-success")');await evaljs('document.querySelector(".notification-success .notification-close").click()');assert.equal(await evaljs('!!document.querySelector(".notification-success")'),false);await wait('document.querySelector(".notification-error")');await wait('!document.querySelector(".notification-card")');const manual=await evaljs('window.notificationEvents.map(e=>({...e,duration:e.hidden-e.shown}))');assert.ok(manual.find(e=>e.kind==='success').duration<1000);assert.ok(manual.find(e=>e.kind==='error').duration>=2900);assert.deepEqual(await evaljs('window.writes'),[]);assert.deepEqual(errors,[]);
fs.writeFileSync(path.join(dir,'../database/notification-timeout-20261109-live.json'),JSON.stringify({automatic,manual,errors,writes:[],checks:['success auto hides in 3 seconds','error auto hides in 3 seconds','independent timers survive parent render','manual dismissal still available']},null,2));console.log('PASS notifications 3s, manual close, no writes',automatic);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});