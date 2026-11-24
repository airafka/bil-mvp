const assert = require('node:assert/strict');
const { init, api, sql, clock, expectStorage } = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    const day = '2026-09-15', next = '2026-09-17';
    await clock(day);
    const a = await x.arrival(undefined, x.a, false);
    const receivingOf = k => sql(`select receiving_order_id from container_owner where container_id='${k}'`);
    assert.equal(receivingOf(a.ktk), a.receiving);
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
    assert.equal(receivingOf(a.ktk), a.receiving);
    const duplicate = await x.transport('receiving',a.ktk,x.a);
    const number = sql(`select number from receiving_order where id='${a.receiving}'`);
    await assert.rejects(x.confirm('receiving',duplicate.id), error =>
        error.message.includes('CONTAINER_RESERVATION_CONFLICT') && error.message.includes('поставка №'+number));
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
    assert.equal((await api(endpoint, 'PUT', {...edit, containerOwnerIds:[bId]}, 400)).code, 'OWNERSHIP_DATE_UNAVAILABLE');
    assert.equal((await api(endpoint)).order.effectiveDate, day, 'Failed edit rolls back header');
    const changed = await api(endpoint, 'PUT', edit);
    assert.equal(changed.order.clientId, x.b);
    assert.equal(changed.order.sourceClientId, x.a);
    const shipping = await x.ship(a.ktk, false);
    assert.equal((await api(endpoint + '/accept', 'POST', undefined, 400)).code, 'OWNERSHIP_DATE_UNAVAILABLE');
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
    await api('/service-orders/'+revoked+'/accept','POST');
    await api('/service-orders/'+revoked+'/withdraw','POST');
    const early = await x.arrival();
    const shipped = await x.transfer(early.ktk,x.b,'2026-09-18');
    await assert.rejects(x.ship(early.ktk), error => error.message.includes('OWNERSHIP_TRANSFER_PLANNED'));
    await api('/service-orders/'+shipped+'/withdraw','POST');
    await x.ship(early.ktk);
    assert.equal(events(second), 0);
    const periods = () => Number(sql(`select count(*) from container_period p join container_visit v on v.id=p.container_visit_id where v.container_id='${a.ktk}'`));
    assert.equal(periods(), 1, 'Future plans have no factual storage periods');
    assert.equal(sql(`select count(*) from service_order_container where service_order_id='${revoked}' and result_status='WITHDRAWN' and container_period_id is null`),'2');
    // Advance the isolated DB calendar without invoking the application's calendar/refresh endpoint.
    sql("update application_clock set business_date='2026-09-19',version=version+1 where id=1");
    assert.equal(current(), x.a);
    const lookup = () => api('/container-owners/lookup','POST',{containerIds:[a.ktk]});
    const selections = await Promise.all([lookup(),lookup()]);
    assert(selections.every(rows=>rows[0].ownerClientId===x.c), 'Shipment selection refreshes overdue transfers');
    assert.equal(periods(), 3);
    assert.equal(current(), x.c);
    const history = await api('/containers/'+a.ktk+'/owner-history');
    const firstChange = history.find(event => event.orderId === draft.id);
    const secondChange = history.find(event => event.orderId === second);
    assert.ok(firstChange?.containerPeriodId);
    assert.equal(secondChange?.previousContainerPeriodId, firstChange.containerPeriodId);
    assert.equal(sql(`select container_period_id from service_order_container where service_order_id='${draft.id}'`),firstChange.containerPeriodId);
    const periodQuery = '?periodId='+firstChange.containerPeriodId+'&status=ALL';
    const report = await api('/container-periods'+periodQuery);
    assert.deepEqual(report.items.map(period => period.id), [firstChange.containerPeriodId]);
    assert.deepEqual(await api('/container-storage-periods'+periodQuery), report);
    for (const [id,date,from,to] of [[draft.id,next,x.a,x.b],[second,'2026-09-18',x.b,x.c]]) {
        assert.equal(events(id), 1);
        assert.equal(sql(`select count(*) from container_owner_history h join container_period p
          on p.start_container_owner_history_id=h.id where h.order_id='${id}' and p.id in
          (select container_period_id from service_order_container where service_order_id=h.order_id and container_id=h.container_id)
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
    await expectStorage(a.ktk,[{ownerClientId:x.a,storageDays:1},{ownerClientId:x.b,storageDays:1},
        {ownerClientId:x.b,storageDays:1},{ownerClientId:x.c,storageDays:2}]);
    await x.transfer(a.ktk,x.a,'2026-09-19');
    await x.transfer(a.ktk,x.c,'2026-09-19');
    const departure = await x.ship(a.ktk);
    await expectStorage(a.ktk,[{ownerClientId:x.a,storageDays:1},{ownerClientId:x.b,storageDays:1},
        {ownerClientId:x.b,storageDays:1},{ownerClientId:x.c,storageDays:1},
        {ownerClientId:x.a,storageDays:0},{ownerClientId:x.c,storageDays:1}]);
    const visitFacts = receiving => sql(`select concat_ws('|',receiving_date,coalesce(shipping_date::text,'open'),is_cancelled)
        from container_visit_facts where container_id='${a.ktk}' and receiving_order_id='${receiving}'`);
    assert.equal(visitFacts(a.receiving), '2026-09-15|2026-09-19|f');
    assert.equal(receivingOf(a.ktk), a.receiving);
    const repeat = await x.arrival(a.ktk,x.b);
    assert.equal(receivingOf(a.ktk), repeat.receiving);
    await x.cancel('receiving', repeat.receiving);
    assert.equal(visitFacts(repeat.receiving), '2026-09-19|open|t');
    assert.equal(receivingOf(a.ktk), a.receiving, 'Cancelling a repeated receipt restores its predecessor');
    assert.equal(await available(x.b, next), false, 'Departed container is ineligible');
    await x.cancel('shipping', departure);
    assert.equal(visitFacts(a.receiving), '2026-09-15|open|f');
    const allHistory = id => api('/containers/'+id+'/owner-history?includeReservations=true');
    const recorded = await allHistory(a.ktk);
    const link = (rows, order, operation) => {
        const event = rows.find(row => row.orderId === order && row.operationType === operation);
        assert.ok(event, operation);
        return event.containerPeriodId ?? null;
    };
    const closedPeriod = link(recorded, departure, 'DEPARTURE');
    const repeatedPeriod = link(recorded, repeat.receiving, 'ARRIVAL');
    assert.ok(closedPeriod && repeatedPeriod && closedPeriod !== repeatedPeriod);
    assert.equal(link(recorded, departure, 'CANCEL_DEPARTURE'), closedPeriod);
    assert.equal(link(recorded, repeat.receiving, 'CANCEL_ARRIVAL'), repeatedPeriod);
    assert.equal(link(recorded, repeat.receiving, 'RESERVE_RECEIVING'), null);

    const original = await x.arrival();
    const start = link(await allHistory(original.ktk), original.receiving, 'ARRIVAL');
    await clock('2026-09-22');
    const reservation = await x.ship(original.ktk, false);
    await x.cancel('shipping', reservation);
    const retroactive = await x.transfer(original.ktk, x.b, '2026-09-20');
    const updated = await allHistory(original.ktk);
    const backdatedPeriod = link(updated, retroactive, 'OWNER_CHANGE');
    assert.ok(start && backdatedPeriod && backdatedPeriod !== start);
    assert.equal(link(updated, reservation, 'RESERVE_SHIPPING'), start);
    assert.equal(link(updated, reservation, 'CANCEL_SHIPPING_RESERVATION'), start);
    const visits = await api('/container-periods/visits?periodId='+firstChange.containerPeriodId);
    assert.equal(visits.items.length, 1);
    assert.equal(visits.items[0].shippingAt ?? null, null);
    console.log('PASS transfer eligibility, reservation, withdrawal, early shipping, dated history, calendar replay, backdating and storage days/CSV');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
