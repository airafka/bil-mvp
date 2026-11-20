const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE || 'docker';
const info=JSON.parse(execFileSync(docker,['inspect','billing-reset-ui-backend'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(info.Config.Env.includes('DB_NAME=billing_reset_ui_test'));assert.equal(info.Config.Labels['billing.task'],'operational-reset-ui');
const base='http://localhost:3025',cwd=process.cwd(),profile=fs.mkdtempSync(path.join(cwd,'reset-ui-profile-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
async function main(){
let port;for(let i=0;i<80;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await pause(100)}assert.ok(port);
const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
let seq=0;const pending=new Map(),errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timeout=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,{resolve:r=>{clearTimeout(timeout);resolve(r)},reject:e=>{clearTimeout(timeout);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaljs(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression){for(let i=0;i<150;i++){if(await evaljs('Boolean('+expression+')'))return;await pause(100)}throw Error('Timeout: '+expression)}
const click=s=>evaljs('document.querySelector('+JSON.stringify(s)+').click()');
const fill=async value=>{await evaljs(`(()=>{const i=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
const shot=async name=>fs.writeFileSync(path.join(cwd,name),(Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64')));
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1366,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:base+'/container-storage'});await wait('document.querySelector(".operational-reset-trigger")');
const before=await(await fetch(base+'/api/system/operational-reset')).json();assert.ok(before.totalRows>0);
await click('.operational-reset-trigger');await wait('document.querySelector("dialog input")');
assert.equal(await evaljs('document.activeElement.getAttribute("aria-label")'),'Закрыть очистку');
assert.ok(await evaljs('document.querySelector(".operational-reset-confirm").disabled'));
await fill('удалить');assert.ok(await evaljs('document.querySelector(".operational-reset-confirm").disabled'));
await shot('reset-ui-desktop.png');
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector("dialog")');
assert.equal((await(await fetch(base+'/api/system/operational-reset')).json()).token,before.token);
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await shot('reset-ui-mobile-header.png');
assert.ok(await evaljs('document.documentElement.scrollWidth<=window.innerWidth+1'),'Mobile horizontal overflow');
await click('.operational-reset-trigger');await wait('document.querySelector("dialog input")');await fill('УДАЛИТЬ');
await wait('!document.querySelector(".operational-reset-confirm").disabled');await shot('reset-ui-mobile.png');
await click('.operational-reset-confirm');
await wait('document.querySelector("dialog [role=status]")?.textContent.includes("очищены")');
assert.ok(await evaljs('document.querySelector(".operational-reset-backup")?.textContent.endsWith(".dump")'));
await click('dialog .primary-button');await wait('document.querySelector(".operational-reset-trigger") && !document.querySelector("dialog")');
assert.equal((await(await fetch(base+'/api/system/operational-reset')).json()).totalRows,0);
await click('.operational-reset-trigger');await wait('document.querySelector("dialog")?.textContent.includes("уже пусты")');
assert.ok(await evaljs('document.querySelector(".operational-reset-confirm").disabled'));
assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile UI, default focus, typed confirmation, Escape without mutation, button reset with backup, report refresh, empty state, no browser errors');
await send('Browser.close');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{ws?.close();try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}await pause(500);assert.equal(path.dirname(path.resolve(profile)),path.resolve(cwd));assert.ok(path.basename(profile).startsWith('reset-ui-profile-'));fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
