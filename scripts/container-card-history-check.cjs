const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { init, api, sql, clock } = require('./owner-register-check.cjs');

async function main() {
    const test = await init('billing-register-owner-new');
    const day = '2026-09-15';
    await clock(day);
    const container = await test.generated();
    const other = await test.generated();
    const card = (id, filters = {}) => api('/containers/' + id + '/card?' + new URLSearchParams(filters));
    const rows = result => result.history.items.map(row => row.orderId);
    const empty = await card(container);
    assert.equal(empty.container.id, container);
    assert.deepEqual(rows(empty), []);
    assert.deepEqual(empty.options.orderNumber, []);
    await api('/containers/' + randomUUID() + '/card', 'GET', undefined, 404);

    const receipt = (await test.transport('receiving', [container, other])).id;
    await test.confirm('receiving', receipt);
    assert.deepEqual(rows(await card(container)), [], 'A reservation is not a completed receipt');
    const arrivalDay = '2026-09-16';
    await clock(arrivalDay);
    const site = (await api('/references/terminal-areas')).find(area => area.code === 'CONTAINER');
    for (const id of [container, other]) {
        const task = sql("select id from receiving_order_container where receiving_order_id='" + receipt + "' and container_id='" + id + "'");
        const number = (await card(id)).container.name;
        const packet = { _order: receipt, _id: task, source: 'TOS', eventCode: 'UNLOAD_FINISH', eventName: 'UNLOAD_FINISH',
            orderNumber: String((await api('/receiving-orders/' + receipt)).code), site: site.name, eventDateTime: arrivalDay + 'T00:05:00+03:00',
            cargoResult: [{ cargoNumber: number, cargoType: 'Контейнер 40', qty: 1, active: true, transportType: 'АВТО', transportNumber: 'А001АА' }] };
        const res = await fetch('http://127.0.0.1:8355/datareon/event', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'External-ID': randomUUID() }, body: JSON.stringify(packet)
        });
        assert.equal(res.status, 200);
        if (id === container) {
            const full = await api('/containers/' + id + '/owner-history?includeReservations=true');
            assert(full.some(row => row.operationType === 'ARRIVAL'));
            assert.deepEqual(rows(await card(id)), [], 'Partial receipt stays out until the order is completed');
        }
    }
    assert.deepEqual(rows(await card(container)), [receipt]);
    const transfer = await test.transfer(container, test.b, arrivalDay);
    const shipping = await test.ship(container);
    const result = await card(container);
    assert.deepEqual(rows(result), [shipping, transfer, receipt]);
    assert.deepEqual(rows(await card(other)), [receipt], 'Another container on the same receipt has its own history');
    assert.deepEqual((await card(other)).options.orderType.map(option => option.value), ['RECEIVING_ORDER']);
    const page = await card(container, { page: 1, size: 1 });
    assert.deepEqual(rows(page), [transfer]);
    assert.equal(page.history.totalElements, 3);
    assert.equal(page.options.orderNumber.length, 3, 'Filter options include all pages');

    const entry = result.history.items.find(row => row.orderId === transfer);
    const recorded = new Date(entry.createdAt).toISOString().slice(0, 10);
    const filters = { orderNumber: entry.orderNumber, orderType: 'SERVICE_ORDER', oldClientId: test.a,
        newClientId: test.b, createdFrom: recorded, createdTo: recorded };
    const filtered = await card(container, filters);
    assert.deepEqual(rows(filtered), [transfer]);
    assert.deepEqual(filtered.options.newClientId.map(option => option.value), [test.b]);
    assert.deepEqual(rows(await card(container, { ...filters, newClientId: test.c })), []);
    assert.deepEqual(rows(await card(container, { createdTo: '2000-01-01' })), []);
    await api('/containers/' + container + '/card?createdFrom=2026-09-17&createdTo=2026-09-15', 'GET', undefined, 400);

    const shippingNumber = String(result.history.items[0].orderNumber);
    await test.cancel('shipping', shipping);
    const afterCancel = await card(container);
    assert.deepEqual(rows(afterCancel), [transfer, receipt], 'Cancellation hides the previously completed shipping order');
    assert(!afterCancel.options.orderNumber.some(option => option.value === shippingNumber));
    assert.deepEqual(rows(await card(container, { orderType: 'SHIPPING_ORDER' })), []);
    const full = await api('/containers/' + container + '/owner-history?includeReservations=true');
    assert(full.some(row => row.orderId === shipping && row.cancellation));
    assert(full.some(row => row.orderId === shipping && row.operationType === 'DEPARTURE'));
    console.log('PASS: partial and completed transport orders, owner change, cancellations, container scope, combined filters, dates, pagination and full stock journal');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
