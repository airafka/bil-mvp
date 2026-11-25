const assert = require('node:assert/strict');
const { init, api, clock, sql } = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    await clock('2026-09-15');
    const first = await x.arrival();
    const containerId = first.ktk;
    const code = sql(`select code from container where id='${containerId}'`);
    const ownerId = sql(`select id from container_owner where container_id='${containerId}'`);
    const details = id => api('/service-orders/' + id);
    async function candidates(date, source, target, draftId) {
        const params = new URLSearchParams({ query: code, effectiveDate: date, sourceClientId: source, clientId: target });
        const path = '/service-orders' + (draftId ? '/' + draftId : '') + '/containers/available?';
        return (await api(path + params)).items;
    }
    function expectPeriods(row, expected) {
        assert.equal(row.containerId, containerId);
        assert.deepEqual(row.visitPeriods.map(p => [p.date, p.orderId, p.transferStatus || p.orderType]), expected);
        assert.ok(row.visitPeriods.every(p => p.orderNumber > 0 && p.ownerName));
        const expectedTimes = JSON.parse(sql(`select json_object_agg(h.order_id, to_char(h.occurred_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) from active_container_period p
            join container_owner_history h on h.id=p.start_container_owner_history_id
            where p.container_visit_id='${row.containerVisitId}'`));
        for (const period of row.visitPeriods) {
            const [seconds, fraction = ''] = period.occurredAt.replace(/Z$/, '').split('.');
            assert.equal(seconds + '.' + fraction.padEnd(6, '0') + 'Z', expectedTimes[period.orderId]);
        }
    }
    const receipt = ['2026-09-15', first.receiving, 'RECEIVING_ORDER'];
    assert.deepEqual(await candidates('2026-09-14', x.a, x.b), []);
    await api('/service-orders', 'POST', { clientId: x.b, sourceClientId: x.a, service: 'CHANGE_OWNER',
        effectiveDate: '2026-09-14', containerOwnerIds: [ownerId] }, 400);
    expectPeriods((await candidates('2026-09-15', x.a, x.b))[0], [receipt]);
    const applied = await x.transfer(containerId, x.b, '2026-09-15');
    const done = ['2026-09-15', applied, 'APPLIED'];
    const pending = await x.transfer(containerId, x.c, '2026-09-18');
    const later = await x.transfer(containerId, x.a, '2026-09-20');
    const plan = ['2026-09-18', pending, 'PLANNED'];
    const sequence = [receipt, done, plan, ['2026-09-20', later, 'PLANNED']];
    expectPeriods((await details(applied)).containers[0], sequence);
    expectPeriods((await candidates('2026-09-16', x.b, x.a))[0], sequence);

    const draft = (await api('/service-orders', 'POST', { clientId: x.a, sourceClientId: x.b,
        service: 'CHANGE_OWNER', effectiveDate: '2026-09-16', containerOwnerIds: [ownerId] }, 201)).order;
    expectPeriods((await candidates('2026-09-16', x.b, x.a, draft.id))[0], sequence);
    expectPeriods((await details(draft.id)).containers[0], sequence);
    await api('/service-orders/' + draft.id, 'DELETE', undefined, 204);
    await api('/service-orders/' + later + '/cancellation', 'POST');
    expectPeriods((await details(pending)).containers[0], [receipt, done, plan]);
    await api('/service-orders/' + pending + '/cancellation', 'POST');
    const firstVisit = (await details(applied)).containers[0];
    expectPeriods(firstVisit, [receipt, done]);

    await x.ship(containerId);
    await clock('2026-09-21');
    const second = await x.arrival(containerId, x.a);
    const newVisit = (await candidates('2026-09-21', x.a, x.b))[0];
    assert.notEqual(newVisit.containerVisitId, firstVisit.containerVisitId);
    expectPeriods(newVisit, [['2026-09-21', second.receiving, 'RECEIVING_ORDER']]);
    assert.deepEqual(await candidates('2026-09-20', x.a, x.b), []);
    const newPlan = await x.transfer(containerId, x.b, '2026-09-23');
    expectPeriods((await details(newPlan)).containers[0], [
        ['2026-09-21', second.receiving, 'RECEIVING_ORDER'], ['2026-09-23', newPlan, 'PLANNED'],
    ]);
    expectPeriods((await details(applied)).containers[0], [receipt, done]);
    console.log('PASS: receipt-day boundary, applied and multiple planned periods, cancellation, create/edit pickers, separate visits and saved orders');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
