const assert = require('node:assert/strict');
const { init, api, sql, clock, expectStorage } = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    const day = '2026-09-15', next = '2026-09-17';
    await clock(day);
    const a = await x.arrival(undefined, x.a, false);
    const b = await x.arrival(undefined, x.b);
    const idOf = k => sql(`select id from container_owner where container_id='${k}'`);
    const [aId, bId] = [idOf(a.ktk), idOf(b.ktk)];
    const available = async (source, date) => {
        const query = new URLSearchParams({ clientId:x.c, sourceClientId:source, effectiveDate:date, query:sql(`select code from container where id='${a.ktk}'`) });
        return (await api('/service-orders/containers/available?' + query)).items.some(row => row.containerId === a.ktk);
    };
    const post = (request, status) => api('/service-orders', 'POST', {service:'CHANGE_OWNER', clientId:x.c, effectiveDate:day, ...request}, status);
    assert.equal(await available(x.a, day), false, 'Expected receipt is ineligible');
    await x.finish('receiving', a.receiving);
    assert.equal(await available(x.a, '2026-09-14'), false);
    assert.equal(await available(x.a, day), true, 'Receipt day is inclusive');
    assert.equal(await available(x.b, day), false);
    await post({sourceClientId:x.a, clientId:x.a, containerOwnerIds:[aId]}, 400);
    await post({containerOwnerIds:[aId,bId]}, 409);
    const draft = (await post({sourceClientId:x.a, containerOwnerIds:[aId]}, 201)).order;
    const endpoint = '/service-orders/' + draft.id;
    assert.equal(draft.sourceClientId, x.a);
    assert.equal(await available(x.a, day), false, 'Another draft holds this container');
    const edit = {id:draft.id, service:'CHANGE_OWNER', clientId:x.b, effectiveDate:next, comment:'revised', containerOwnerIds:[aId]};
    await api(endpoint, 'PUT', {...edit, containerOwnerIds:[bId]}, 409);
    assert.equal((await api(endpoint)).order.effectiveDate, day, 'Failed edit rolls back header');
    const changed = await api(endpoint, 'PUT', edit);
    assert.equal(changed.order.clientId, x.b);
    assert.equal(changed.order.sourceClientId, x.a);
    const shipping = await x.ship(a.ktk, false);
    await api(endpoint + '/accept', 'POST', undefined, 409);
    assert.equal((await api(endpoint)).order.status, 'DRAFT');
    await x.cancel('shipping', shipping);
    await api(endpoint + '/accept', 'POST');
    const current = () => sql(`select client_id from container_owner where container_id='${a.ktk}'`);
    assert.equal(current(), x.a, 'Future transfer waits for the calendar');
    const events = id => Number(sql(`select count(*) from container_owner_history where order_id='${id}'`));
    assert.equal(events(draft.id), 0);
    const second = await x.transfer(a.ktk,x.c,'2026-09-18');
    const revoked = await x.transfer(b.ktk,x.c,'2026-09-18');
    await api('/service-orders/'+revoked+'/withdraw','POST');
    const early = await x.arrival();
    const shipped = await x.transfer(early.ktk,x.b,'2026-09-18');
    await x.ship(early.ktk);
    assert.equal(events(second), 0);
    await clock('2026-09-19');
    assert.equal(current(), x.c);
    for (const [id,date,from,to] of [[draft.id,next,x.a,x.b],[second,'2026-09-18',x.b,x.c]]) {
        assert.equal(events(id), 1);
        assert.equal(sql(`select count(*) from container_owner_history h join container_ownership_period p
          on p.start_container_owner_history_id=h.id where h.order_id='${id}' and h.storage_period_id=p.id
          and (h.occurred_at at time zone 'Europe/Moscow')::date='${date}' and h.old_client_id='${from}' and h.new_client_id='${to}'`),'1');
    }
    assert.equal(events(revoked), 0);
    assert.equal(events(shipped), 0);
    await expectStorage(a.ktk,[{ownerClientId:x.a,storageDays:2},{ownerClientId:x.b,storageDays:1},{ownerClientId:x.c,storageDays:2}]);
    await clock(day);
    assert.equal(current(), x.a);
    await clock('2026-09-19');
    assert.equal(events(draft.id), 1);
    assert.equal(events(second), 1);
    const back = await x.transfer(a.ktk,x.b,'2026-09-16');
    assert.equal(events(back), 1);
    assert.equal(current(), x.c);
    await x.ship(a.ktk);
    assert.equal(await available(x.b, next), false, 'Departed container is ineligible');
    console.log('PASS transfer eligibility, reservation, withdrawal, early shipping, dated history, calendar replay, backdating and storage days/CSV');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
