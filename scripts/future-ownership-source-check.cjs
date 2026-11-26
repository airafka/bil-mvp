// Run on the isolated, restored owner-register test environment.
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { init, api, clock, sql } = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    await clock('2026-11-15');
    const first = await x.arrival();
    const other = await x.arrival();
    const stockId = id => sql(`select id from container_owner where container_id='${id}'`);
    const stockOwner = id => sql(`select client_id from container_owner where container_id='${id}'`);
    const code = sql(`select code from container where id='${first.ktk}'`);
    const selected = [first, other].map(k => stockId(k.ktk));

    await clock('2026-11-16');
    const earlier = await x.transfer(first.ktk, x.b, '2026-11-17');
    const payload = { service: 'CHANGE_OWNER', effectiveDate: '2026-11-19', isDeferred: true,
        sourceClientId: x.a, clientId: x.c, containerOwnerIds: selected };
    async function candidates(source, target, day, draftId) {
        const params = new URLSearchParams({ query: code, sourceClientId: source, clientId: target, effectiveDate: day });
        const root = '/service-orders' + (draftId ? '/' + draftId : '');
        return (await api(root + '/containers/available?' + params)).items;
    }
    const candidate = (await candidates(x.a, x.c, payload.effectiveDate))[0];
    assert.equal(candidate.clientId, x.a);
    assert.equal(candidate.visitPeriods.at(-1).orderId, earlier);
    assert.deepEqual(await candidates(x.b, x.c, payload.effectiveDate), []);
    assert.deepEqual(await candidates(x.a, x.b, payload.effectiveDate), []);
    await api('/service-orders', 'POST', { ...payload, sourceClientId: x.b, containerOwnerIds: [selected[0]] }, 400);
    const draft = await api('/service-orders', 'POST', payload, 201);
    const path = '/service-orders/' + draft.order.id;
    assert.equal((await candidates(x.a, x.c, payload.effectiveDate, draft.order.id))[0].clientId, x.a);
    await api(path + '/containers', 'PUT', selected.map(containerOwnerId => ({ containerOwnerId })));
    const confirmed = await api(path + '/accept', 'POST');
    assert.equal(confirmed.order.status, 'SCHEDULED');
    assert.equal(confirmed.order.oldClientOwner.id, x.a);
    // Both containers belong to A today. Only the first passes through B before the 19th.
    for (const [ktk, previous] of [[first.ktk, x.b], [other.ktk, x.a]]) {
        const link = confirmed.containers.find(row => row.containerId === ktk);
        assert.equal(link.expectedClientId, previous);
        assert.equal(sql(`select old_client_id || '/' || new_client_id from container_owner_history
            where container_id='${ktk}' and order_id='${draft.order.id}'`), previous + '/' + x.c);
        assert.equal(stockOwner(ktk), x.a);
    }
    async function advance(day, orderId, expected) {
        await clock(day);
        for (let i = 0; i < 90; i++) {
            if ((await api('/service-orders/' + orderId)).order.status === 'DONE') break;
            await delay(1000);
        }
        assert.equal((await api('/service-orders/' + orderId)).order.status, 'DONE');
        assert.equal(stockOwner(first.ktk), expected);
    }
    await advance('2026-11-17', earlier, x.b);
    assert.equal(stockOwner(other.ktk), x.a);
    await advance('2026-11-19', draft.order.id, x.c);
    assert.equal(stockOwner(other.ktk), x.c);
    assert.equal((await candidates(x.a, x.c, '2026-11-16'))[0].clientId, x.a);
    assert.deepEqual(await candidates(x.b, x.c, '2026-11-16'), []);
    console.log('PASS: current owner for future selection, saved draft, per-container predecessors, due transfers and backdated selection');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
