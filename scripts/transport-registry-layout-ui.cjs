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







const results=[];
for(const section of ['receiving-orders','shipping-orders']){
 await send('Page.navigate',{url:'http://localhost:3001/'+section});await wait('document.querySelector(".transport-order-registry tbody .order-code")');
 for(const width of [2320,1920,1440,1280,1024,640,360,320]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(180);
  const state=await evaljs('(()=>{const t=document.querySelector(".transport-order-registry"),r=t.tBodies[0].rows[0];return {records:t.classList.contains("responsive-table--records"),overflow:document.documentElement.scrollWidth>innerWidth+1,gap:t.parentElement.clientWidth-t.getBoundingClientRect().width,height:r.getBoundingClientRect().height,columns:[...r.cells].map(c=>({text:c.textContent,width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height})),codes:[...t.querySelectorAll("tbody .order-code")].map(c=>c.textContent)}})()');
  assert.equal(state.overflow,false);assert.ok(Math.abs(state.gap)<2);assert.ok(state.codes.length>0);
  if(process.argv.includes('--verify')&&!state.records){assert.ok(state.height<=55,'Compact row: '+JSON.stringify({section,width,...state}));assert.ok(state.columns[4].width>state.columns[7].width*2,'Terminal wider than service number');}
  results.push({section,width,...state});
  if(process.argv.includes('--verify')&&[1440,360].includes(width))fs.writeFileSync(path.join(dir,'../database/transport-registry-'+section+'-'+width+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 const next=await evaljs('(()=>{const b=[...document.querySelectorAll(".pagination button")].find(b=>b.textContent==="Далее");if(b&&!b.disabled){b.click();return true}return false})()');
 if(next){await wait('document.querySelector(".pagination span").textContent.includes("Страница 2")');await wait('document.querySelector(".transport-order-registry tbody .order-code")');assert.equal(await evaljs('document.querySelector(".transport-order-registry tbody .registry-index").textContent'),'21');}
}
fs.writeFileSync(path.join(dir,'../database/transport-registry-layout-'+(process.argv.includes('--verify')?'after':'before')+'.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({section,width,height,records,columns})=>({section,width,height,records,columns:columns.map(c=>Math.round(c.width))}))));console.log('PROFILE',profile);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
