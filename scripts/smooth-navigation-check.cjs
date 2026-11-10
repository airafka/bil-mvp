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









const base=process.env.BILLING_UI_BASE||'http://localhost:3192';
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.addScriptToEvaluateOnNewDocument',{source:'const original=window.fetch;window.fetch=(...a)=>{if(a[1]?.method&&!["GET","HEAD"].includes(a[1].method.toUpperCase()))throw Error("Read only");return original(...a)}'});
await send('Page.navigate',{url:base+'/receiving-orders'});await wait('document.querySelector(".transport-order-registry tbody .order-code")');
const results=[];
for(const reduced of [false,true]){
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
 const route=reduced?'/receiving-orders':'/shipping-orders';
 await evaljs('document.querySelector(\'.nav-section-toggle[aria-label="Заявки"]\').click()');await pause(300);
 const frames=await evaljs('new Promise(resolve=>{const frames=[],start=performance.now();document.querySelector('+JSON.stringify('a[href="'+route+'"]')+').click();function sample(){const m=document.querySelector("main"),s=getComputedStyle(m),t=m.querySelector("table"),p=t?.parentElement;frames.push({time:performance.now()-start,path:location.pathname,opacity:Number(s.opacity),transform:s.transform,animations:m.getAnimations().length,overflow:p?p.scrollWidth-p.clientWidth:0,settling:document.querySelector(".app-shell").classList.contains("navigation-settling")});if(performance.now()-start<450)requestAnimationFrame(sample);else resolve(frames)}requestAnimationFrame(sample)})');
 assert.equal(frames.at(-1).opacity,1);assert.equal(frames.at(-1).settling,false);assert.ok(frames.every(f=>f.transform==='none'&&f.overflow<=1));
 if(reduced)assert.ok(frames.every(f=>f.opacity===1&&f.animations===0),'Reduced motion skips reveal');else assert.ok(frames.some(f=>f.opacity>.55&&f.opacity<1&&f.animations>0),'Visible smooth reveal');
 results.push({reduced,frames});
}
fs.writeFileSync(path.join(dir,'../database/smooth-navigation-check.json'),JSON.stringify({base,results},null,2));console.log('PASS smooth reveal, final opacity, reduced motion, stable table width and cleanup');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
