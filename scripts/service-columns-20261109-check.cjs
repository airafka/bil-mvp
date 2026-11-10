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







const base='http://localhost:3001',before=process.argv.includes('--before');
const service=JSON.parse(fs.readFileSync(path.join(dir,'../database/charges-tabs-20261109-before.json'),'utf8')).service;
await send('Page.addScriptToEvaluateOnNewDocument',{source:`const native=window.fetch;window.fetch=(...args)=>{if(args[1]?.method&&!['GET','HEAD'].includes(args[1].method.toUpperCase()))throw Error('Read only verification');return native(...args)}`});
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+service});await wait('document.querySelector("#service-tab-returns")');
const results=[];
for(const width of [1440,1280,1200,1024,640,360,320]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(300);const panels={};
 for(const tab of ['shipping','returns','receiving']){
  await evaljs('document.getElementById('+JSON.stringify('service-tab-'+tab)+').click()');await pause(50);
  panels[tab]=await evaljs('(()=>{const t=document.querySelector('+JSON.stringify('#service-panel-'+tab+' table')+'),frame=t.parentElement,r=frame.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,scroll:frame.scrollWidth>frame.clientWidth+1,tableWidth:t.getBoundingClientRect().width,columns:[...t.tHead.rows[0].cells].map(c=>({left:c.getBoundingClientRect().left-r.left,width:c.getBoundingClientRect().width})),pageOverflow:document.documentElement.scrollWidth>innerWidth+1}})()');
 }
 if(!before){assert.deepEqual(panels.shipping.columns,panels.returns.columns,'Auto columns at '+width);assert.equal(panels.shipping.top,panels.returns.top,'Auto table top at '+width);if(width>=1200)assert.equal(panels.receiving.scroll,false,'Railway fits at '+width);assert.ok(Object.values(panels).every(p=>!p.pageOverflow));if(width===1280)fs.writeFileSync(path.join(dir,'../database/service-columns-20261109-railway-1280.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
 results.push({width,panels});
}
fs.writeFileSync(path.join(dir,'../database/service-columns-20261109-'+(before?'before':'after')+'.json'),JSON.stringify(results,null,2));console.log(before?'Recorded original column geometry':'PASS matching auto columns on7widths and no railway scroll at1200/1280/1440');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});