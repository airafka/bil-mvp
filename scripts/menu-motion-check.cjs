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









const base=process.env.BILLING_UI_BASE||'http://localhost:3192';await send('Emulation.setFocusEmulationEnabled',{enabled:true});
await send('Page.addScriptToEvaluateOnNewDocument',{source:'const original=window.fetch;window.fetch=(...a)=>{if(a[1]?.method&&!["GET","HEAD"].includes(a[1].method.toUpperCase()))throw Error("Read only");return original(...a)}'});
async function capture(action){return evaljs('new Promise(resolve=>{const frames=[],start=performance.now();'+action+';function sample(){const shell=document.querySelector(".app-shell"),side=document.querySelector(".sidebar"),w=document.querySelector(".workspace"),table=document.querySelector(".transport-order-registry"),p=table?.parentElement;frames.push({ms:performance.now()-start,path:location.pathname,closing:shell.dataset.menuClosing,sidebar:side.getBoundingClientRect().width,left:w.getBoundingClientRect().left,scroll:p?p.scrollWidth-p.clientWidth:0,scrollbar:p?getComputedStyle(p).scrollbarColor:null});if(performance.now()-start<650)requestAnimationFrame(sample);else resolve(frames)}requestAnimationFrame(sample)})')}
const results=[];
for(const width of [1440,1366]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/receiving-orders'});await wait('document.querySelector(".registry-table-reveal[aria-busy=false]")');await pause(550);const opening=await capture('document.querySelector(\'.nav-section-toggle[aria-label="Заявки"]\').click()');const closing=await capture('document.querySelector(\'a[href="/shipping-orders"]\').click()');
for(const [label,frames] of [['opening',opening],['closing',closing]]){assert.ok(new Set(frames.filter(f=>f.sidebar>73&&f.sidebar<279).map(f=>Math.round(f.sidebar))).size>=3,label+' gradual movement');assert.ok(frames.every(f=>Math.abs(f.left-f.sidebar)<1),label+' workspace follows sidebar')}
assert.ok(closing.filter(f=>f.closing==='true'&&f.scroll>1).every(f=>f.scrollbar==='rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)'));assert.equal(closing.at(-1).closing,'false');assert.equal(Math.round(closing.at(-1).sidebar),72);assert.equal(closing.at(-1).path,'/shipping-orders');if(width===1440)assert.equal(closing.at(-1).scroll,0);else{assert.ok(closing.at(-1).scroll>0);assert.notEqual(closing.at(-1).scrollbar,'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)')}results.push({width,opening,closing})}
await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await evaljs('document.querySelector(\'.nav-section-toggle[aria-label="Заявки"]\').click()');await pause(50);const reduced=await capture('document.querySelector(\'a[href="/receiving-orders"]\').click()');assert.ok(reduced.every(f=>f.closing==='false'&&Math.round(f.sidebar)===72));results.push({reduced});
await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
await evaljs('document.querySelector(\'.nav-section-toggle[aria-label="Заявки"]\').click()');await pause(300);
const reversed=await capture('document.querySelector(\'a[href="/shipping-orders"]\').click();setTimeout(()=>document.querySelector(\'.nav-section-toggle[aria-label="Заявки"]\').click(),70)');assert.equal(reversed.at(-1).closing,'false');assert.equal(Math.round(reversed.at(-1).sidebar),280);results.push({reversed});
for(const width of [320,360,640,1024]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(400);await evaljs('document.querySelector(\'a[href="/receiving-orders"]\').click()');await pause(600);const state=await evaljs('({closing:document.querySelector(".app-shell").dataset.menuClosing,scroll:document.documentElement.scrollWidth,width:innerWidth})');assert.equal(state.closing,'false');assert.ok(state.scroll<=Math.max(320,state.width)+1);results.push({width,state})}
fs.writeFileSync(path.join(dir,'../database/menu-motion-'+(process.env.BILLING_REPORT||'test')+'.json'),JSON.stringify({base,results},null,2));console.log('PASS gradual synchronized movement, temporary scrollbar paint, narrow scroll restored, reduced motion');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
