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








await send('Emulation.setFocusEmulationEnabled',{enabled:true});
await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.bulkWrites=[];const original=window.fetch;window.fetch=(url,init)=>{if(init?.method&&!['GET','HEAD'].includes(init.method.toUpperCase())){window.bulkWrites.push(String(url));throw Error('Read only live verification')}return original(url,init)}`});
const list=await(await fetch('http://localhost:8081/api/receiving-orders?page=0&size=100&status=DRAFT')).json();const order=list.items.find(x=>x.transportType==='RAILWAY');assert.ok(order);
await send('Page.navigate',{url:'http://localhost:3001/receiving-orders/'+order.id});await wait('document.querySelector(".view-tabs")');await evaljs('[...document.querySelectorAll(".stepper button")].find(e=>e.textContent==="КТК").click()');await wait('document.querySelector(".bulk-owner-toolbar button")');const results=[];
const button='.bulk-owner-toolbar > button';
for(const width of [1920,1440,1024,640,360,320]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false});await pause(200);
 assert.equal(await evaljs('document.querySelectorAll(".container-owner-choice").length'),0);
 assert.equal(await evaljs('document.querySelector('+JSON.stringify(button)+').disabled'),false);
 assert.equal(await evaljs('document.querySelector('+JSON.stringify(button)+').classList.contains("primary-button")'),true);
 await evaljs('document.querySelector('+JSON.stringify(button)+').click()');await wait('document.querySelector(".bulk-owner-field select")?.options.length>1');
 assert.equal(await evaljs('document.querySelector('+JSON.stringify(button)+').disabled'),true);
 assert.equal(await evaljs('document.querySelector(".bulk-owner-field select").value'),'');
 if(width===1920)fs.writeFileSync(path.join(dir,'../database/owner-inline-live-empty.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await evaljs('(()=>{const s=document.querySelector(".bulk-owner-field select");s.value=s.options[1].value;s.dispatchEvent(new Event("change",{bubbles:true}))})()');
 assert.equal(await evaljs('document.querySelector('+JSON.stringify(button)+').disabled'),true);
 await evaljs('(()=>{const e=document.querySelector(".container-child-row .container-owner-choice input");e.focus();e.click()})()');
 assert.equal(await evaljs('document.querySelector('+JSON.stringify(button)+').disabled'),false);
 const r=await evaljs('(()=>{const b=document.querySelector(".bulk-owner-toolbar > button").getBoundingClientRect(),s=document.querySelector(".bulk-owner-field select"),p=s.getBoundingClientRect(),tabs=document.querySelector(".order-tabs-toolbar > .stepper").getBoundingClientRect();return{fieldLeft:p.left,fieldRight:p.right,fieldTop:p.top,buttonLeft:b.left,buttonTop:b.top,topGap:Math.abs(tabs.top-b.top),height:p.height,multiple:s.multiple,pageOverflow:document.documentElement.scrollWidth>innerWidth+1}})()');
 assert.equal(r.height,40);assert.equal(r.multiple,false);assert.equal(r.pageOverflow,false);assert.ok(r.fieldLeft>=0&&r.fieldRight<=width);
 if(width>=1440){assert.ok(r.fieldRight<r.buttonLeft);assert.equal(r.fieldTop,r.buttonTop);assert.ok(r.topGap<2)}results.push({width,...r});
 if([1920,360].includes(width))fs.writeFileSync(path.join(dir,'../database/owner-inline-live-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await evaljs('(()=>{const e=document.querySelector(".container-child-row .container-owner-choice input");e.focus();e.click()})()');assert.equal(await evaljs('document.querySelector('+JSON.stringify(button)+').disabled'),true);
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector(".bulk-owner-field")');
}
assert.deepEqual(await evaljs('window.bulkWrites'),[]);fs.writeFileSync(path.join(dir,'../database/owner-inline-20261109-live.json'),JSON.stringify({order:order.id,results,writes:[]},null,2));console.log('PASS inline owner live UI: activation, both requirements, alignment, Escape; no writes');ws.close();chrome.kill();})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
