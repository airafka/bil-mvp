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







const base='http://localhost:3001',service=JSON.parse(fs.readFileSync(path.join(dir,'../database/charges-tabs-20261109-before.json'),'utf8')).service;await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+service});await wait('document.querySelector("#service-tab-returns")');const results=[];
for(const width of [1280,1440,1920,2292,2320,2560,2865])for(const zoom of [1,.9,1.1,1.25]){
await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await evaljs('document.documentElement.style.zoom='+zoom);await pause(300);
for(const tab of ['shipping','returns','receiving','charges']){await evaljs('document.getElementById('+JSON.stringify('service-tab-'+tab)+').click()');await pause(40);results.push({width,zoom,tab,...await evaljs('(()=>{const t=document.querySelector('+JSON.stringify('#service-panel-'+tab+' table')+'),p=t.parentElement,s=getComputedStyle(p),ts=getComputedStyle(t),r=p.getBoundingClientRect();return {client:p.clientWidth,scroll:p.scrollWidth,delta:p.scrollWidth-p.clientWidth,frame:r.width,table:t.getBoundingClientRect().width,configured:t.style.getPropertyValue("--responsive-table-width"),border:[s.borderLeftWidth,s.borderRightWidth],tableBorder:[ts.borderLeftWidth,ts.borderRightWidth],sum:[...t.tHead.rows[0].cells].reduce((v,c)=>v+parseFloat(c.style.getPropertyValue("--responsive-column-width")),0),cellBorder:[getComputedStyle(t.tHead.rows[0].cells[0]).borderLeftWidth,getComputedStyle(t.tHead.rows[0].cells[0]).borderRightWidth]}})()')});}
}
fs.writeFileSync(path.join(dir,'../database/table-scroll-20261109-before.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results.filter(r=>r.delta>0&&r.client>=1200).slice(0,15),null,2));console.log('OVERFLOW',results.filter(r=>r.delta>0&&r.client>=1200).length,'OF',results.length);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});