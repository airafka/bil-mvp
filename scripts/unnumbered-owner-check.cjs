const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { init, api, sql, clock } = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    await clock('2026-12-01');
    const area = (await api('/references/terminal-areas')).find(a => a.code === 'CONTAINER');
    const contract = sql("select contract_id from complex_service_tariff where active and client_id='"+x.a+"' limit 1");
    const client = (await api('/references/clients')).find(c => c.id === x.a);
    const common = {clientId:x.a,contractId:contract,terminalAreaId:area.id,consignee:client.name,departureAt:'2026-12-02T12:00:00'};
    const vehicles = await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
    async function route(id) {
        const res = await api('/routes','POST',{routeType:'SHIPPING',transportType:'VEHICLE',terminalAreaId:area.id,
            departureAt:'2026-12-02T12:00:00+03:00',orderIds:[id],carrierId:vehicles[0][0].id,driverId:vehicles[1][0].id,vehicleId:vehicles[2][0].id},201);
        return '/routes/'+res.route.id+'/confirm';
    }
    async function send(id,ktk,task=randomUUID()) {
        const code=sql("select code from container where id='"+ktk+"'");
        const res=await fetch('http://127.0.0.1:8355/datareon/event',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},
            body:JSON.stringify({_id:task,_order:id,orderNumber:'1',source:'TOS',site:area.name,eventCode:'LOAD_FINISH',eventName:'Погрузка завершена',eventDateTime:'2026-12-03T12:00:00+03:00',
                cargoResult:[{cargoNumber:code,cargoType:'Контейнер 20',qty:1,active:true,transportType:'АВТО',transportNumber:'А000АА'}]})});
        assert.equal(res.status,200);
        return res.json();
    }
    const auto = (await api('/shipping-orders','POST',{...common,transportType:'VEHICLE',fillingType:'NONE_CONTAINER',
        containerQuantities:[{type:'STANDARD_20',quantity:1,empty:true,items:[]}]},201)).id;
    const group=(await api('/shipping-orders/'+auto)).containerQuantities[0];
    const autoRoute=await route(auto);
    assert.match((await api(autoRoute,'POST',{},409)).detail,/собственника КТК/);
    const zero=(await api('/references/container-stock-owners')).find(c=>c.available===0 && c.id!==x.a);
    const ownerPath='/shipping-orders/'+auto+'/plan/containers/'+group.id+'/owner';
    await api(ownerPath,'PUT',{ownerId:zero.id},204);
    assert.match((await api(autoRoute,'POST',{},409)).detail,/нет свободных КТК/);
    const foreign=await x.generated();
    await x.arrival(foreign,zero.id);
    assert.match((await api(autoRoute,'POST',{},409)).detail,/типоразмера/);
    async function generateTwenty() {
        const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);
        return sql("select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='"+bill.id+"'");
    }
    const small=await generateTwenty();
    await x.arrival(small,zero.id);
    await api(autoRoute,'POST',{});
    const actual=await generateTwenty(); await x.arrival(actual,x.a);
    assert.equal((await send(auto,actual)).status,'DONE');
    assert.equal(sql("select owner_container_id from shipping_order_container where shipping_order_id='"+auto+"'"),x.a);
    assert.equal(sql("select owner_client_id from shipping_order_container_qty where shipping_order_id='"+auto+"'"),zero.id);
    console.log('PASS auto: missing owner, no stock, wrong type, confirmed plan versus actual TOS owner');

}
main().catch(e=>{ console.error(e); process.exitCode=1; });
