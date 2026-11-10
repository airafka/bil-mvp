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









const base='http://localhost:3001';const api=async p=>{const r=await fetch(base+'/api'+p);return r.ok?r.json():null};
const services=await api('/comprehensive-service-orders?size=100');let id;
for(const item of services.items){const rows=await api('/comprehensive-service-orders/'+item.id+'/returns/available-containers');if(rows?.length){id=item.id;break}}assert.ok(id);const source=await api('/comprehensive-service-orders/'+id);
await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.returnWrites=[];const old=window.fetch;window.fetch=(url,init)=>{if(init?.method&&!['+JSON.stringify('GET')+','+JSON.stringify('HEAD')+'].includes(init.method.toUpperCase())){window.returnWrites.push(String(url));throw Error("Read only verification")}return old(url,init)}'});
await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+id});await wait('document.querySelector("#service-tab-shipping")');await evaljs('document.querySelector("#service-tab-shipping").click()');await evaljs('[...document.querySelectorAll("button")].find(e=>e.textContent==="Создать возврат").click()');await wait('document.querySelector("dialog select")?.options.length>1');
const options=await evaljs('[...document.querySelector("dialog select").options].map(o=>o.value)');assert.ok(!options.includes(source.order.clientId));
await evaljs('(()=>{const e=document.querySelector("dialog select");e.value=e.options[1].value;e.dispatchEvent(new Event("change",{bubbles:true}))})()');
const owner='document.querySelector('+JSON.stringify('dialog select[aria-label="Собственник КТК"]')+')';await wait(owner+'?.options.length>1');assert.equal(await evaljs(owner+'.value'),'');assert.equal(await evaljs('document.querySelector("dialog button[type=submit]").disabled'),true);
const layouts=[];for(const width of [1440,360]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(150);assert.equal(await evaljs('document.documentElement.scrollWidth>innerWidth+1'),false);layouts.push(width);fs.writeFileSync(path.join(dir,'../database/return-owner-live-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
await evaljs('document.querySelector(".return-current-client input").click()');assert.equal(await evaljs('!!'+owner),false);assert.deepEqual(await evaljs('window.returnWrites'),[]);
await evaljs('document.querySelector("dialog .close-button").click()');await wait('!document.querySelector("dialog[open]")');fs.writeFileSync(path.join(dir,'../database/return-owner-20261109-live.json'),JSON.stringify({id,layouts,writes:[],sourceClientExcluded:true,ownerInitiallyEmpty:true,hiddenForCurrentClient:true},null,2));console.log('PASS live return UI, no writes');ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});