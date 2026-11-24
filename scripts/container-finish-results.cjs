const assert = require('node:assert/strict');
const {init, api, clock, sql, json} = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    await clock('2026-09-15');
    const pair = await api('/waybills/generate','POST',{standard20:2,standard40:0},201);
    const [a,b] = json(`select json_agg(wc.container_id order by wc.id) from waybill_container wc
        join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${pair.id}'`);
    const event = (kind,order,containerId,status=200) => api('/'+kind+'-orders/'+order+'/events','POST',{
        eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH',containerId
    },status);
    const state = k => sql(`select status from container_owner where container_id='${k}'`);
    const history = k => api('/containers/'+k+'/owner-history');
    const receipt = (await x.transport('receiving',[a,b])).id;
    const route = await x.confirm('receiving',receipt);
    const bad = await event('receiving',receipt,await x.generated(),409);
    assert.equal(bad.code,'CONTAINER_NOT_IN_ORDER');
    const first = await Promise.all([event('receiving',receipt,b),event('receiving',receipt,b)]);
    assert(first.every(order=>order.status==='CONFIRMED'));
    assert.equal(state(a),'EXPECTED');
    assert.equal(state(b),'ON_TERMINAL');
    assert.equal((await history(b)).filter(h=>h.orderId===receipt && h.operationType==='ARRIVAL').length,1);
    assert.equal(sql(`select status from route where id='${route}'`),'CONFIRMED');
    await x.transfer(b,x.b,'2026-09-15');
    await clock('2026-09-16');
    assert.equal((await x.finish('receiving',receipt)).status,'COMPLETED');
    assert.equal((await event('receiving',receipt,b)).status,'COMPLETED');
    assert.equal(sql(`select string_agg(receiving_date::text,',' order by receiving_date) from container_visit_facts where receiving_order_id='${receipt}'`),'2026-09-15,2026-09-16');
    assert.equal(sql(`select status from route where id='${route}'`),'COMPLETED');
    const shipping = (await x.transport('shipping',[a,b])).id;
    await x.confirm('shipping',shipping);
    assert.equal((await event('shipping',shipping,a)).status,'CONFIRMED');
    assert.equal(state(a),'DEPARTED');
    assert.equal(state(b),'RESERVED_OUT');
    assert((await history(a)).some(h=>h.orderId===shipping && h.operationType==='DEPARTURE'));
    assert.equal(sql(`select count(*) from container_visit_facts where receiving_order_id='${receipt}' and shipping_date is not null`),'1');
    await x.cancel('shipping',shipping);
    assert.equal(state(a),'ON_TERMINAL');
    assert.equal(state(b),'ON_TERMINAL');
    assert.equal(sql(`select count(*) from container_visit_facts where receiving_order_id='${receipt}' and shipping_date is not null`),'0');
    const again = (await x.transport('shipping',[a,b])).id;
    await x.confirm('shipping',again);
    const results = await Promise.all([event('shipping',again,a),event('shipping',again,b)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['COMPLETED','CONFIRMED']);
    await x.finish('shipping',again);
    assert.equal(sql(`select count(*) from container_owner_history_view where order_id='${again}' and operation_type='DEPARTURE'`),'2');

    const repeat = (await x.transport('receiving',[a,b])).id;
    await x.confirm('receiving',repeat);
    await event('receiving',repeat,a);
    await x.cancel('receiving',repeat);
    assert.equal(sql(`select count(*) from container_visit_facts where receiving_order_id='${repeat}' and is_cancelled`),'1');
    assert.equal(sql(`select count(*) from receiving_order_container where receiving_order_id='${repeat}' and status is not null`),'0');

    const bill=await api('/waybills/generate','POST',{standard20:2,standard40:0},201);
    const contract=(await api("/references/contracts?clientId="+x.a))[0];
    const request={clientId:x.a,contractId:contract.id,defaultContainerOwnerId:x.a,waybillIds:[bill.id]};
    async function confirmedRail() {
        const order=await api('/comprehensive-service-orders','POST',request,201);
        const section='/comprehensive-service-orders/'+order.order.id;
        await api(section+'/prepare-transport','POST',{section:'INITIAL_RECEIVING'});
        await api(section+'/complete-section','POST',{section:'INITIAL_RECEIVING',action:'CONFIRM_ROUTES'});
        return order;
    }
    const rail=await confirmedRail();
    const railK=rail.receivingOrder.containers[0].containerId;
    assert.equal((await event('receiving',rail.receivingOrder.id,railK)).status,'CONFIRMED');
    const visits=orderId=>json(`select coalesce(json_agg(json_build_object('id',v.id,'cancelled',v.is_cancelled,
        'task',t.task_id,'status',t.status) order by v.container_id),'[]') from container_visit_facts v
        left join visit_receiving_tasks t on t.receiving_order_id=v.receiving_order_id and t.container_id=v.container_id
        where v.receiving_order_id='${orderId}'`);
    const [original]=visits(rail.receivingOrder.id);
    assert.equal(original.status,'FINISHED');
    for(const shipping of rail.shippingOrders) await x.cancel('shipping',shipping.id);
    await x.cancel('receiving',rail.receivingOrder.id);
    const reused=await confirmedRail();
    await event('receiving',reused.receivingOrder.id,railK);
    const old=visits(rail.receivingOrder.id), current=visits(reused.receivingOrder.id);
    assert.deepEqual(old,[{id:original.id,cancelled:true,task:null,status:null}]);
    assert.equal(current.length,1);
    assert.equal(current[0].task,original.task);
    assert.equal(current[0].cancelled,false);
    assert.notEqual(current[0].id,original.id);
    await x.transfer(railK,x.b,'2026-09-16');
    await api('/comprehensive-service-orders/'+reused.order.id+'/complete-section','POST',{section:'INITIAL_RECEIVING',action:'COMPLETE_ORDERS'});
    assert.equal(visits(reused.receivingOrder.id).length,2);
    console.log('PASS row completion, retry, route completion, partial receipt/dispatch cancellation, transfer, railway delivery and reuse of a cancelled waybill');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
