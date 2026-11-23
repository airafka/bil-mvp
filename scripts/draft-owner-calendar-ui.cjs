// Regression against the built UI only: every /api/* request is intercepted and mocked.
// No backend/database access or operational mutations. Start the temporary frontend on 5173.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const base = 'http://127.0.0.1:5173';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-draft-owner-ui-'));
const chrome = spawn(process.env.CHROME_EXE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, send, evaluate;
let clock = { date: '2026-09-15', fixedDate: '2026-09-15', mode: 'FIXED', timeZone: 'Europe/Moscow', now: '2026-09-15T12:00:00+03:00', systemNow: '2026-11-20T09:00:00Z', version: 1 };
let transport = 'VEHICLE', status = 'DRAFT', lookupMode = '', lookupCount = 0;
const held = [], errors = [], unexpected = [];
const clients = ['А', 'Б', 'В'].map((name, index) => ({ id: 'owner-' + index, name: 'Собственник ' + name }));
const saved = { containerId: 'saved', containerName: 'SAVED1234567', empty: false, ownerClientId: 'owner-0', ownerClientName: clients[0].name, sealNumbers: 'original', cargo: null, cargoItems: [], containerStatus: 'ON_TERMINAL' };
const order = () => ({ id: 'audit-order', code: 999, status, clientId: 'owner-0', clientName: clients[0].name, contractId: 'contract', contractName: 'Договор', terminalArea: { id: 'area', name: 'Площадка' },
  transportType: transport, fillingType: 'ALL', containers: transport === 'VEHICLE' ? [saved] : [], railwayCarriages: transport === 'RAILWAY' ? [{ railwayCarriageId: 'wagon', railwayCarriageCode: '12345678', containers: [saved] }] : [],
  waybills: [], containerQuantities: [], arrivalAt: null, departureAt: '2026-09-15T12:00:00', consignee: clients[0].name, consignor: null, returnOrders: [] });
const ownerAt = date => date >= '2026-09-18' ? clients[2] : date >= '2026-09-17' ? clients[1] : clients[0];
async function fulfill(id, body, code = 200) {
  await send('Fetch.fulfillRequest', { requestId: id, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
}
async function handleRequest({ requestId, request }) {
  const url = new URL(request.url), p = url.pathname;
  if (p === '/api/application-clock') return fulfill(requestId, clock);
  if (p === '/api/system/operational-reset/availability') return fulfill(requestId, { enabled: false });
  if (p === '/api/routes') return fulfill(requestId, []);
  if (p.startsWith('/api/shipping-orders/') && request.method === 'GET') return fulfill(requestId, order());
  if (p.startsWith('/api/references/')) {
    const resource = p.split('/').at(-1);
    return fulfill(requestId, resource === 'clients' ? clients : resource === 'containers' ? [{ id: 'added', name: 'ADDED1234567' }] : resource === 'etsng-codes' ? [{ id: 'cargo', name: '123456' }] : []);
  }
  if (p === '/api/container-owners/lookup') {
    lookupCount++;
    const selected = ownerAt(clock.date);
    const body = JSON.parse(request.postData).containerIds.map(containerId => ({ containerId, ownerClientId: selected.id, ownerClientName: selected.name, status: 'ON_TERMINAL' }));
    if (lookupMode === 'hold') { held.push({ requestId, body }); return; }
    if (lookupMode === 'fail') { lookupMode = ''; return fulfill(requestId, { detail: 'Тестовая ошибка обновления собственника' }, 503); }
    return fulfill(requestId, body);
  }
  unexpected.push(request.method + ' ' + p);
  return fulfill(requestId, { detail: 'Unexpected mocked API request' }, 501);
}
async function wait(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate('Boolean(' + expression + ')')) return; await pause(50); }
  throw new Error('Timeout: ' + expression);
}
const click = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
const button = text => evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===' + JSON.stringify(text) + ').click()');
const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);
const owners = () => evaluate('[...document.querySelectorAll(".order-container-table .container-readonly")].map(e=>e.textContent)');
const value = label => evaluate('document.querySelector(' + JSON.stringify('[aria-label="' + label + '"]') + ').value');
async function setDate(date) {
  clock = { ...clock, date, fixedDate: date, now: date + 'T12:00:00+03:00', version: clock.version + 1 };
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait('document.querySelector(".application-clock-trigger").textContent.includes(' + JSON.stringify(date.split('-').reverse().join('.')) + ')');
}
async function main() {
  let port;
  for (let i = 0; i < 100; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await pause(50); } }
  assert.ok(port, 'Chrome must start');
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) { const request = pending.get(message.id); pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    if (message.method === 'Fetch.requestPaused') handleRequest(message.params).catch(error => errors.push(String(error)));
    if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params.exceptionDetails));
  });
  evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: base + '/api/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (transport of ['VEHICLE', 'RAILWAY']) {
    status = 'DRAFT'; clock = { ...clock, date: '2026-09-15', fixedDate: '2026-09-15', version: clock.version + 1 };
    await send('Page.navigate', { url: base + '/shipping-orders/audit-order' });
    await wait('document.querySelector("button[aria-label=Редактировать]")');
    await click('[aria-label="Редактировать"]');
    await fill('[aria-label="Дата и время вывоза"]', '2030-12-31T15:45');
    await wait('document.querySelector("[aria-label=Грузополучатель]").options.length>1');
    await fill('[aria-label="Грузополучатель"]', clients[2].name);
    await button('КТК');
    await wait('document.querySelector(".container-readonly")?.textContent==="Собственник А"');
    await fill('[aria-label="Номера ЗПУ — SAVED1234567"]', 'manual-saved');
    await button('⊕ Добавить');
    await fill('[aria-label="Номер КТК — строка 2"]', 'added');
    await wait('document.querySelector(' + JSON.stringify('[aria-label="Номера ЗПУ — ADDED1234567"]') + ')');
    await fill('[aria-label="Номера ЗПУ — ADDED1234567"]', 'manual-added');
    await fill('[aria-label="Груз по ЕТСНГ — ADDED1234567"]', 'cargo');
    await fill('[aria-label="Масса брутто, кг — ADDED1234567"]', '123.45');
    await wait('[...document.querySelectorAll(".container-readonly")].length===2 && [...document.querySelectorAll(".container-readonly")].every(e=>e.textContent==="Собственник А")');
    lookupMode = 'hold'; await setDate('2026-09-17');
    await wait('[...document.querySelectorAll(".container-readonly")].every(e=>e.textContent==="Загрузка…")');
    for (let i = 0; !held.length && i < 100; i++) await pause(50);
    assert.equal(held.length, 1);
    await setDate('2026-09-18');
    for (let i = 0; held.length < 2 && i < 100; i++) await pause(50);
    assert.equal(held.length, 2);
    lookupMode = ''; const newer = held.pop(), older = held.pop();
    await fulfill(newer.requestId, newer.body);
    await wait('[...document.querySelectorAll(".container-readonly")].every(e=>e.textContent==="Собственник В")');
    await fulfill(older.requestId, older.body); await pause(150);
    assert.deepEqual(await owners(), [clients[2].name, clients[2].name], 'Older lookup cannot replace the new date');
    lookupMode = 'fail'; await setDate('2026-09-19');
    await wait('document.querySelector(".order-container-section [role=alert]")');
    assert.deepEqual(await owners(), ['Не удалось обновить', 'Не удалось обновить']);
    await click('.order-container-section [role="alert"] button');
    await wait('[...document.querySelectorAll(".container-readonly")].every(e=>e.textContent==="Собственник В")');
    assert.equal(await value('Номера ЗПУ — SAVED1234567'), 'manual-saved');
    assert.equal(await value('Номера ЗПУ — ADDED1234567'), 'manual-added');
    assert.equal(await value('Груз по ЕТСНГ — ADDED1234567'), 'cargo');
    assert.equal(await value('Масса брутто, кг — ADDED1234567'), '123.45');
    assert.equal(await value('Номер КТК — строка 2'), 'added');
    await button('Основное');
    assert.equal(await value('Дата и время вывоза'), '2030-12-31T15:45');
    assert.equal(await value('Грузополучатель'), clients[2].name);
    status = 'CONFIRMED';
    await send('Page.navigate', { url: base + '/shipping-orders/audit-order' });
    await wait('document.querySelector(".view-tabs")'); await button('КТК');
    await wait('document.querySelector(".container-readonly")?.textContent==="Собственник А"');
    const before = lookupCount; await setDate('2026-09-20'); await pause(100);
    assert.equal(lookupCount, before, 'Confirmed shipping must not use current owner lookup');
    assert.deepEqual(await owners(), [clients[0].name]);
    console.log('PASS ' + transport + ': latest calendar owner, preserved edits/additions, stale response ignored, visible error/retry, frozen confirmed owner');
  }
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
}
main().finally(async () => {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} ws.close(); }
  chrome.kill();
  await pause(300);
  const resolved = path.resolve(profile), tmp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), tmp); assert.ok(path.basename(resolved).startsWith('billing-draft-owner-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}).catch(error => { console.error(error); process.exitCode = 1; });
