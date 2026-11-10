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







await send('Page.addScriptToEvaluateOnNewDocument',{source:`const native=window.fetch;window.fetch=(...args)=>{if(args[1]?.method&&!["GET","HEAD"].includes(args[1].method.toUpperCase()))throw Error("Read only");return native(...args)}`});

await send('Page.navigate',{url:'http://localhost:3192/comprehensive-service-orders/7c961843-da07-4120-a839-d85e925f206d'});await wait('document.querySelector("#service-tab-shipping")');await evaljs('document.getElementById("service-tab-shipping").click()');await pause(300);
for(const mode of ['percent','container'])for(const width of [320,1440,1920]){
await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(300);
console.log(mode,width,await evaljs('(()=>{const t=document.querySelector("#service-panel-shipping table"),p=t.parentElement,w=[44,140,190,220,260,170,120];p.style.containerType="inline-size";[...t.tHead.rows[0].cells].forEach((c,i)=>c.style.setProperty("--responsive-column-width",i===0?"44px":'+JSON.stringify(mode)+'==="percent"?w[i]/1100*100+"%":"calc((max(100cqw, 1144px) - 44px) * "+w[i]/1100+")"));return {width:t.getBoundingClientRect().width,columns:[...t.tHead.rows[0].cells].map(c=>c.getBoundingClientRect().width),overflow:[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth&&getComputedStyle(e).position!=="fixed").slice(0,7).map(e=>[e.tagName,e.className,e.getBoundingClientRect().right]),doc:document.documentElement.scrollWidth}})()'));
}ws.close();chrome.kill();})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
