// Browser acceptance checks against the isolated ownership scheduler stack only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',base='http://127.0.0.1:3224';
const info=JSON.parse(execFileSync(docker,['inspect','billing-owner-schedule-backend-test'],{encoding:'utf8',windowsHide:true}))[0];
assert.ok(info.Config.Env.includes('DB_NAME=billing_owner_schedule_test'));assert.ok(info.Config.Env.includes('DB_HOST=billing-owner-schedule-db-test'));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'billing-owner-schedule-ui-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let ws;
(async()=>{
 let port;for(let i=0;i<80;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await pause(100);}assert.ok(port);
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
 let seq=0;const pending=new Map(),errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}});
 function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('Browser timeout: '+method)),15000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}));});}
 async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 async function wait(expression){for(let i=0;i<120;i++){if(await evaluate('Boolean('+expression+')'))return;await pause(100);}throw Error('UI timeout: '+expression+'\n'+await evaluate('document.body.innerText.slice(-2200)'));}
 async function api(p,method='GET',body){const r=await fetch(base+'/api'+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();}
 async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});await evaluate('window.dispatchEvent(new Event("focus"))');}
 async function navigate(p){await send('Page.navigate',{url:base+p});await wait('document.querySelector(".application-clock-trigger")');}
 const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
 const button=text=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();})()`);
 const fill=(selector,value)=>evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(i instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event(i instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setTimezoneOverride',{timezoneId:'America/Los_Angeles'});await send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
 await navigate('/service-orders/new');const original=await api('/application-clock');
 await wait('document.querySelector(".ownership-page input[type=date]")');assert.equal(await evaluate('document.querySelector(".ownership-page input[type=date]").value'),original.date);
 await clock('2026-10-02');await wait('document.querySelector(".ownership-page input[type=date]").value==="2026-10-02"');
 await fill('.ownership-page input[type=date]','2026-10-05');await clock('2026-10-03');await pause(500);assert.equal(await evaluate('document.querySelector(".ownership-page input[type=date]").value'),'2026-10-05');
 await fill('.ownership-page input[type=date]','');await clock('2026-10-04');await pause(500);assert.equal(await evaluate('document.querySelector(".ownership-page input[type=date]").value'),'');
 await fill('.ownership-page input[type=date]','2026-10-05');
 await wait('document.querySelector(".ownership-page select")?.options.length>1');
 const eligible=JSON.parse(execFileSync(docker,['exec','billing-owner-schedule-db-test','psql','-X','-U','billing','-d','billing_owner_schedule_test','-At','-c',"select coalesce(json_agg(container_id),'[]') from container_owner o where (select max(occurred_at) from container_owner_history h where h.container_id=o.container_id) < '2026-10-04'::timestamptz"],{encoding:'utf8',windowsHide:true}));
 const clients=await api('/references/clients');let client,selection,selectionPage;
 for(const item of clients){for(let page=0;page<100;page++){const available=await api('/service-orders/containers/available?clientId='+item.id+'&page='+page);selection=available.items.find(x=>eligible.includes(x.containerId));if(selection){client=item.id;selectionPage=page;break;}if(page+1>=available.totalPages)break;}if(selection)break;}assert.ok(selection);
 await fill('.ownership-page select',client);await button('Далее →');await wait('document.querySelector(".ownership-container-table input[type=checkbox]")');
 for(let p=0;p<selectionPage;p++){await button('Далее');await wait(`document.querySelector('.pagination span')?.textContent.startsWith('${p+2} /')`);}
 const checkbox='input[aria-label="Выбрать КТК '+selection.containerName+'"]';await wait('document.querySelector('+JSON.stringify(checkbox)+')');await click(checkbox);await button('Создать');
 await wait('document.querySelector(".ownership-page h1")?.textContent.includes("№")');const orderId=await evaluate('location.pathname.split("/").at(-1)');
 assert.equal((await api('/service-orders/'+orderId)).order.effectiveDate,'2026-10-05');
 await click('button[aria-label="Редактировать"]');await wait('document.querySelector("#ownership-effective-date")');await fill('#ownership-effective-date','2026-10-06');await button('Сохранить');
 await wait('!document.querySelector("#ownership-effective-date")');await button('Подтвердить');await wait('document.querySelector(".ownership-status")?.textContent==="Ожидает выполнения"');
 assert.equal(await evaluate('Boolean(document.querySelector("button[aria-label=Редактировать]"))'),false);
 assert.equal((await api('/service-orders/'+orderId)).order.effectiveDate,'2026-10-06');
 for(const width of [1440,1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});await pause(600);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Page overflow '+width);}
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
 await pause(1000);
 if(process.env.OWNERSHIP_UI_SCREENSHOT){const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.OWNERSHIP_UI_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await button('Вернуть в черновик');await wait('document.querySelector(".ownership-status")?.textContent==="Черновик"');await button('Подтвердить');await wait('document.querySelector(".ownership-status")?.textContent==="Ожидает выполнения"');
 await clock('2026-10-06');await wait('document.querySelector(".ownership-status")?.textContent==="Выполнено"');
 await navigate('/service-orders');await wait('document.querySelector(".ownership-registry-table tbody tr a")');assert.ok(await evaluate('document.querySelector(".ownership-registry-table thead").textContent.includes("Дата передачи")'));
 for(const width of [1440,1024,640,360,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});await pause(150);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Registry overflow '+width);}
 await evaluate('document.body.style.zoom="90%"');assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 assert.deepEqual(errors,[]);console.log('PASS UI: calendar default/manual/clear, create/edit/confirm/withdraw/automatic completion, 5 viewport sizes, registry date, 90% zoom, non-Moscow browser timezone; no JS exceptions');
 await send('Browser.close');
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{
 ws?.close();chrome.kill();
 assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));assert.ok(path.basename(profile).startsWith('billing-owner-schedule-ui-'));
 for(let i=0;i<20;i++){try{fs.rmSync(profile,{recursive:true,force:true});break;}catch{await pause(200);}}
});
