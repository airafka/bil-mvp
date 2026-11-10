const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const session = JSON.parse(fs.readFileSync(path.join(root, 'database/refactor-20261109-session.json'), 'utf8').replace(/^\uFEFF/, ''));
const docker = 'C:/Users/Green-0482/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
assert.match(session.database, /^billing_next_refactor_\d{8}_\d{6}$/);
for (const container of [session.backend, session.baseline]) {
  const info = JSON.parse(execFileSync(docker, ['inspect', container], { windowsHide: true, encoding: 'utf8' }))[0];
  assert.ok(info.Config.Env.includes('DB_NAME=' + session.database), 'Only prepared test databases');
}
const oldBase = 'http://localhost:8193', newBase = 'http://localhost:8192';
let comparisons = 0, contexts = 0;
async function call(base, url, body) {
  const response = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3192' }, body: JSON.stringify(body) } : undefined);
  assert.equal(response.status, 200, url + ': ' + response.status);
  return response.json();
}
async function compare(url, body) {
  const [oldValue, newValue] = await Promise.all([call(oldBase, url, body), call(newBase, url, body)]);
  const transportOrders = newValue.transportOrders;
  delete newValue.transportOrders;
  assert.deepEqual(newValue, oldValue, url + ' ' + JSON.stringify(body));
  comparisons++;
  return { value: newValue, transportOrders };
}
async function all(resource) {
  const items = [];
  for (let page = 0; ; page++) {
    const { value } = await compare(resource + '?page=' + page + '&size=100');
    items.push(...value.items);
    if (items.length >= value.totalElements) return items;
    assert.ok(value.items.length);
  }
}
(async () => {
  const services = await all('/api/comprehensive-service-orders');
  for (const service of services) {
    const { value, transportOrders } = await compare('/api/comprehensive-service-orders/' + service.id);
    const ids = new Set([value.receivingOrder.id, ...value.shippingOrders.map(x => x.id), ...value.returnOrders.filter(x => x.comprehensiveServiceOrderId === service.id).map(x => x.id)]);
    assert.deepEqual(new Set(transportOrders.map(x => x.id)), ids, 'Context ownership');
    for (const context of transportOrders) {
      const resource = context.kind === 'SHIPPING' ? 'shipping-orders' : 'receiving-orders';
      const { value: order } = await compare('/api/' + resource + '/' + context.id);
      assert.equal(context.status, order.status); assert.equal(context.terminalAreaId, order.terminalArea.id); assert.equal(context.transportType, order.transportType);
      assert.equal(context.route?.id ?? null, order.routeId ?? null);
      if (context.route) {
        const route = await call(oldBase, '/api/routes/' + context.route.id);
        assert.equal(context.route.code, route.route.code);
      }
      contexts++;
    }
  }
  for (const resource of ['receiving-orders', 'shipping-orders']) for (const order of await all('/api/' + resource)) await compare('/api/' + resource + '/' + order.id);
  await compare('/api/billing-charges?size=100'); await compare('/api/payment-invoices?size=100'); await compare('/api/routes');
  const { value: options } = await compare('/api/waybills/available/options');
  for (const filter of [{}, ...options]) {
    const query = new URLSearchParams({ ...filter, size: '100' });
    await compare('/api/waybills/available?' + query);
  }
  for (const availableForReceivingOrderOnly of [true, false]) for (const sortingColumn of ['departureStation', 'destinationStation', 'payer', 'railwayCarriageCount', 'containerCount', 'waybillCount']) for (const sortingDirection of ['ASC', 'DESC']) for (const page of [0, 1, 999]) {
    await compare('/api/waybills/grouped/page', { pageInfo: { page, size: 1 }, sortingColumn, sortingDirection, availableForReceivingOrderOnly });
  }
  await compare('/api/waybills/grouped/page', { pageInfo: { page: 0, size: 100 }, availableForReceivingOrderOnly: false });
  const report = { database: session.database, services: services.length, contexts, comparisons, status: 'PASS', mutations: 0 };
  fs.writeFileSync(path.join(root, 'database/refactor-20261109-api-check.json'), JSON.stringify(report, null, 2)); console.log(report);
})().catch(error => { console.error(error); process.exitCode = 1; });
