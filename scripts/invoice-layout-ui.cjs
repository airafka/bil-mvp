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
await send('Page.addScriptToEvaluateOnNewDocument',{source:"const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method&&!['GET','HEAD','OPTIONS'].includes(init.method.toUpperCase()))throw Error('Read-only audit');return originalFetch(input,init)}"});
const services=await(await fetch(base+'/api/comprehensive-service-orders')).json();const service=services.items.find(s=>s.code===2870);assert.ok(service,'Service 2870');
const routes=['payment-invoices/new'];
for(const route of routes){for(const [physicalWidth,zoom] of [[1920,1],[1920,.9],[1440,1],[1440,.9],[1280,.9],[1024,1],[360,1]]){
 const width=Math.round(physicalWidth/zoom);await send('Emulation.setDeviceMetricsOverride',{width,height:Math.round(1000/zoom),deviceScaleFactor:zoom,mobile:false});
 await send('Page.navigate',{url:base+'/'+route});await wait('document.querySelector(".content h1")');
 if(route==='payment-invoices/new'){
 await wait('document.querySelector(".invoice-filters select")?.options.length>1');
 await evaljs('(()=>{const e=document.querySelector(".invoice-filters select");e.value='+JSON.stringify(service.clientId)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await wait('[...document.querySelectorAll(".invoice-filters select")[1].options].some(o=>o.value==='+JSON.stringify(service.contractId)+')');
 await evaljs('(()=>{const e=document.querySelectorAll(".invoice-filters select")[1];e.value='+JSON.stringify(service.contractId)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await wait('document.querySelector("button[form=invoice-filter]:not(:disabled)")');await evaljs('document.querySelector("button[form=invoice-filter]").click()');
 }
 if(route.startsWith('comprehensive')){await wait('document.getElementById("service-tab-charges")');await evaljs('document.getElementById("service-tab-charges").click()')}
 await wait('document.querySelector(".service-charge-table tbody tr,.billing-charge-registry-table tbody tr,.invoice-lines-table tbody tr")');await pause(150);
 const r=await evaljs(String.raw`(()=>{const t=document.querySelector('.service-charge-table,.billing-charge-registry-table,.invoice-lines-table');const overlap=[];for(const cell of t.querySelectorAll('tbody td')){const box=cell.getBoundingClientRect(),walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(!n.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(n);for(const b of range.getClientRects())if(b.right>box.right+1||b.left<box.left-1)overlap.push({text:n.textContent,right:b.right,cellRight:box.right,whiteSpace:getComputedStyle(cell).whiteSpace});}}return {overlap,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,rowHeights:[...t.tBodies[0].rows].map(r=>r.getBoundingClientRect().height),cols:[...t.tHead.rows[0].cells].map(c=>({label:c.textContent,width:c.getBoundingClientRect().width})),tableWidth:t.clientWidth,frameWidth:t.parentElement.clientWidth}})()`);
 results.push({route,physicalWidth,zoom,...r});
 if([1440,1920].includes(physicalWidth)&&zoom===.9)fs.writeFileSync(path.join(dir,'../database/invoice-layout-'+(route.startsWith('comprehensive')?'service':'registry')+'-'+physicalWidth+(process.argv.includes('--before')?'-before':'')+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
}}
fs.writeFileSync(path.join(dir,'../database/invoice-layout-'+(process.argv.includes('--before')?'before':'after')+'.json'),JSON.stringify(results,null,2));
console.log('CHECKS',results.length,'OVERLAPS',results.filter(r=>r.overlap.length).length,'PAGE_OVERFLOW',results.filter(r=>r.pageOverflow).length,'PROFILE',profile);
ws.close();chrome.kill();if(!process.argv.includes('--before')){assert.ok(results.every(r=>r.overlap.length===0&&!r.pageOverflow));assert.ok(results.filter(r=>r.route==='billing-charges'&&r.physicalWidth>=1440).every(r=>r.rowHeights.every(h=>h<=56)),'Registry rows should fit two text lines');}
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
