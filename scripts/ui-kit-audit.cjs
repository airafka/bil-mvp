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









const base='http://localhost:3001';const results=[];
for(const width of [1440,1024,360,320]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:base+'/ui-kit'});await wait('document.querySelector("table.responsive-table")');await pause(150);
 const r=await evaljs('(()=>{const visible=e=>e.getBoundingClientRect().height>0;return {overflow:document.documentElement.scrollWidth>innerWidth+1,buttons:[...document.querySelectorAll(".content .primary-button,.content .secondary-button")].filter(visible).map(e=>({text:e.textContent,h:e.getBoundingClientRect().height,table:!!e.closest("table"),font:getComputedStyle(e).fontSize})),fields:[...document.querySelectorAll(".content input.ui-control,.content select.ui-control")].map(e=>({h:e.getBoundingClientRect().height,table:!!e.closest("table")})),row:document.querySelector("table tbody tr:last-child").getBoundingClientRect().height,scroll:document.querySelector("table").parentElement.scrollWidth>document.querySelector("table").parentElement.clientWidth}})()');
 assert.equal(r.overflow,false);for(const b of r.buttons){assert.equal(b.h,b.table?30:40,JSON.stringify(b));assert.equal(b.font,'14px')};for(const f of r.fields)assert.equal(f.h,f.table?30:40,JSON.stringify(f));assert.ok(r.row>=36&&r.row<=56);results.push({width,...r});
 await evaljs('document.querySelector("table select").value="two";document.querySelector("table select").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector(".composition-group button").click()');
 await wait('!document.querySelector("table select")');await evaljs('document.querySelector(".composition-group button").click()');
 await wait('document.querySelector("table select")?.value==="two"');
 if(width<600){await evaljs('document.querySelector("table").parentElement.focus()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await pause(150);assert.ok(await evaljs('document.querySelector("table").parentElement.scrollLeft>0'));}
 fs.writeFileSync(path.join(dir,'../database/ui-kit-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
}
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/container-owners'});await wait('document.querySelector("table.responsive-table")');assert.equal(await evaljs('document.querySelectorAll(".content input,.content select").length'),0);fs.writeFileSync(path.join(dir,'../database/ui-standard-stock.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
fs.writeFileSync(path.join(dir,'../database/ui-kit-audit.json'),JSON.stringify(results,null,2));console.log('PASS component sizes and keyboard scroll',JSON.stringify(results));console.log('PROFILE',profile);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
