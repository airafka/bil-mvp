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






const base='http://localhost:3001',list=await(await fetch(base+'/api/comprehensive-service-orders')).json(),results=[];
let own=0,foreign=0;
for(const order of list.items){
 const detail=await(await fetch(base+'/api/comprehensive-service-orders/'+order.id)).json();
 const expected=detail.returnOrders.filter(r=>r.comprehensiveServiceOrderId===order.id).map(r=>String(r.code));
 own+=expected.length;foreign+=detail.returnOrders.length-expected.length;
 for(const width of [1440,360]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:base+'/comprehensive-service-orders/'+order.id});
  await wait('document.getElementById("service-tab-returns")');
  await evaljs('document.getElementById("service-tab-returns").click()');
  await wait('document.getElementById("service-panel-returns")&&!document.getElementById("service-panel-returns").hidden');
  const actual=await evaljs('Array.from(document.querySelectorAll("#service-panel-returns .order-code")).map(e=>e.textContent)');
  assert.deepEqual(actual,expected,'Return ownership '+order.code);
  assert.equal(await evaljs('document.body.textContent.includes("Возвраты создаются кнопкой")'),false);
  assert.equal(await evaljs('document.documentElement.scrollWidth>innerWidth+1'),false);
  if(!expected.length)assert.ok(await evaljs('document.getElementById("service-panel-returns").textContent.includes("Возвратных поставок пока нет")'));
  results.push({code:order.code,width,returns:actual,excluded:detail.returnOrders.length-expected.length});
 }
}
assert.ok(own>0&&foreign>0,'Live fixtures cover own and foreign returns');
fs.writeFileSync(path.join(dir,'../database/return-ownership-ui-audit.json'),JSON.stringify(results,null,2));
console.log('PASS',JSON.stringify(results),'PROFILE',profile);ws.close();chrome.kill();
})().catch(e=>{console.error(e);chrome.kill();process.exitCode=1});
