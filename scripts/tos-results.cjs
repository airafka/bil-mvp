const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {init,api,clock,sql,json} = require('./owner-register-check.cjs');

async function main() {
    const x = await init('billing-register-owner-new');
    const site = (await api('/references/terminal-areas')).find(area => area.code==='CONTAINER');
    const contract = sql("select contract_id from complex_service_tariff where active and client_id='"+x.a+"' limit 1");
    const party = (await api('/references/clients')).find(c=>c.id===x.a).name;
    let wagon = {code:'00000000'};
    const codeOf = id => sql("select code from container where id='"+id+"'");
    const task = (kind,order,id) => sql("select id from "+kind+"_order_container where "+kind+"_order_id='"+order+"' and container_id='"+id+"'");
    const audit = (id,operation) => sql("select occurred_at at time zone 'Europe/Moscow' from container_owner_history_view where container_id='"+id+"' and operation_type='"+operation+"' order by created_at desc limit 1");
    function cargo(number,railway=true) {
        return {cargoNumber:number,cargoType:'Контейнер 40',qty:1,active:true,
            transportType:railway?'ЖД':'АВТО',transportNumber:railway?wagon.code:'А001АА',seals:[{code:'SEAL01'}]};
    }
    function packet(order,taskId,eventCode,eventDateTime,results) {
        return {_order:order,_id:taskId,orderNumber:'1000001',source:'TOS',site:site.name,eventCode,eventName:eventCode,eventDateTime,cargoResult:results};
    }
    async function send(body,status='DONE') {
        const externalId=randomUUID();
        const headers={'Content-Type':'application/json','External-ID':externalId};
        if (body.eventCode === 'LOAD_FINISH') headers.Prefer = 'return=representation';
        const res=await fetch('http://127.0.0.1:8355/datareon/event',{method:'POST',headers,body:JSON.stringify(body)});
        const response = await res.text();
        assert.equal(res.status,200,response);
        if (headers.Prefer) assert.equal(JSON.parse(response).status,status,response);
        else assert.equal(response,'');
        const result=json("select row_to_json(r) from (select status,status_details from inbound_event where external_id='"+externalId+"') r");
        assert.equal(result.status,status,JSON.stringify(result));
    }

    await clock('2026-09-14');
    const ids=[await x.generated(),await x.generated()];
    const receipt=(await x.transport('receiving',ids)).id;
    await x.confirm('receiving',receipt);
    await clock('2026-09-18');
    const at='2026-09-15T23:55:00+03:00';
    const first=packet(receipt,task('receiving',receipt,ids[0]),'UNLOAD_FINISH',at,[cargo(codeOf(ids[0]),false)]);
    await send({...first,eventCode:'UNKNOWN'},'SKIPPED');
    await send({...first,_id:randomUUID()},'INVALID');
    await Promise.all([send(first),send(first)]);
    assert.equal(audit(ids[0],'ARRIVAL'),'2026-09-15 23:55:00');
    assert.equal(sql("select count(*) from container_visit_facts where receiving_order_id='"+receipt+"'"),'1');
    assert.equal(sql("select order_status from receiving_order where id='"+receipt+"'"),'CONFIRMED');
    await send({...first,eventDateTime:'2026-09-16T18:00:00Z'});
    assert.equal(audit(ids[0],'ARRIVAL'),'2026-09-15 23:55:00');
    await send(packet(receipt,task('receiving',receipt,ids[1]),'UNLOAD_FINISH','2026-09-16T00:05:00+03:00',[cargo(codeOf(ids[1]),false)]));
    assert.equal(sql("select order_status from receiving_order where id='"+receipt+"'"),'COMPLETED');
    const noTime={...first}; delete noTime.eventDateTime;
    assert.equal((await fetch('http://127.0.0.1:8355/datareon/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(noTime)})).status,400);

    const service = (await api('/comprehensive-service-orders/available-services'))[0];
    const tariff = json("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='"+service.id+"' and active limit 1)t");
    const bill = await api('/waybills/generate','POST',{standard20:1,standard40:0},201);
    const railOrder = await api('/comprehensive-service-orders','POST',{complexServiceId:service.id,clientId:tariff.client_id,
        contractId:tariff.contract_id,defaultContainerOwnerId:x.a,defaultRailwayCarriageOwnerId:x.b,waybillIds:[bill.id]},201);
    wagon=json("select row_to_json(w) from (select c.id,c.code,c.type_id from waybill_railway_carriage wr join railway_carriage c on c.id=wr.railway_carriage_id where wr.waybill_id='"+bill.id+"' limit 1)w");
    const wagonStatus=()=>sql("select status from railway_carriage_owner where railway_carriage_id='"+wagon.id+"'");
    const section = '/comprehensive-service-orders/'+railOrder.order.id;
    await api(section+'/prepare-transport','POST',{section:'INITIAL_RECEIVING'});
    await api(section+'/complete-section','POST',{section:'INITIAL_RECEIVING',action:'CONFIRM_ROUTES'});
    const railRow=json("select row_to_json(t) from (select wc.id,c.code from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id join container c on c.id=wc.container_id where wr.waybill_id='"+bill.id+"')t");
    await clock('2026-09-21');
    await send(packet(railOrder.receivingOrder.id,railRow.id,'UNLOAD_FINISH','2026-09-20T12:00:00+03:00',[cargo(railRow.code)]));
    assert.equal(sql("select status from waybill_container where id='"+railRow.id+"'"),'FINISHED');
    assert.equal(sql("select receiving_date from container_visit_facts where receiving_order_id='"+railOrder.receivingOrder.id+"'"),'2026-09-20');

    assert.equal(wagonStatus(),'ON_TERMINAL');
    assert.equal(sql("select client_owner_id from railway_carriage_owner where railway_carriage_id='"+wagon.id+"'"),x.b);
    for (const mode of ['ALL','CONTAINER','RAILWAY_CARRIAGE','NONE','NONE_CONTAINER']) {
        await clock('2026-10-01');
        const [a,b]=[await x.generated(),await x.generated()];
        await x.arrival(a); await x.arrival(b);
        const rail=mode!=='NONE_CONTAINER';
        const known=mode==='ALL'||mode==='CONTAINER';
        const rows=[a,b].map(containerId=>({containerId,empty:true}));
        const body={clientId:x.a,contractId:contract,terminalAreaId:site.id,transportType:rail?'RAILWAY':'VEHICLE',
            fillingType:mode,departureAt:'2026-10-01T12:00:00',consignee:party,
            containers:mode==='CONTAINER'?rows:[],
            railwayCarriages:mode==='ALL'||mode==='RAILWAY_CARRIAGE'?[{railwayCarriageId:wagon.id,containers:mode==='ALL'?rows:[]}]:[],
            railwayCarriageQuantities:['CONTAINER','NONE'].includes(mode)?[{quantity:1,typeId:wagon.type_id,ownerRailwayCarriageId:x.b}]:[],
            containerQuantities:known?[]:[{quantity:rail?2:1,type:'STANDARD_40',empty:true,items:[],ownerClientId:x.a}]};
        if (!rail) {
            await api('/shipping-orders','POST',{...body,containerQuantities:[{...body.containerQuantities[0],quantity:2}]},400);
        }
        const order=(await api('/shipping-orders','POST',body,201)).id;
        const detail=await api('/shipping-orders/'+order);
        assert.equal(detail.fillingType,mode);
        if (mode==='CONTAINER') assert.equal(detail.containers.find(row=>row.containerId===a).taskId,task('shipping',order,a));
        if (mode==='RAILWAY_CARRIAGE') assert.equal(detail.railwayCarriages[0].railwayCarriageCode,wagon.code);
        if (!known) assert.equal(detail.containerQuantities[0].quantity,rail?2:1);
        if (rail) {
            const route=await api('/routes','POST',{routeType:'SHIPPING',departureAt:'2026-10-01T12:00:00+03:00',transportType:'RAILWAY',terminalAreaId:site.id,orderIds:[order]},201);
            if (mode==='CONTAINER') {
                sql("update shipping_order_railway_carriage_qty set quantity=10000 where shipping_order_id='"+order+"'");
                await api('/routes/'+route.route.id+'/confirm','POST',{},409);
                sql("update shipping_order_railway_carriage_qty set quantity=1 where shipping_order_id='"+order+"'");
            }
            await api('/routes/'+route.route.id+'/confirm','POST',{});
            assert.equal(wagonStatus(),['ALL','RAILWAY_CARRIAGE'].includes(mode)?'RESERVED_OUT':'ON_TERMINAL');
        } else await x.confirm('shipping',order);
        await clock('2026-10-04');
        if (mode!=='ALL') await x.finish('shipping',order,409);
        const make=(id,i)=>packet(order,known?task('shipping',order,id):randomUUID(),'LOAD_FINISH','2026-10-0'+(i+2)+'T10:11:12+03:00',[cargo(codeOf(id),rail)]);
        const pa=make(a,0),pb=make(b,1);
        if (mode==='RAILWAY_CARRIAGE') await send({...pa,cargoResult:[{...pa.cargoResult[0],transportNumber:'00000000'}]},'INVALID');
        if (mode==='NONE') {
            const invalidCargo={...pb.cargoResult[0],cargoSpec:[{code:'not-a-catalog-code',qty:125}]};
            await send({...pa,cargoResult:[...pa.cargoResult,invalidCargo]},'INVALID');
            assert.equal(sql("select count(*) from shipping_order_container where shipping_order_id='"+order+"'"),'0');
            assert.equal(sql("select count(*) from shipping_order_railway_carriage where shipping_order_id='"+order+"'"),'0');
            const etsng = sql('select code from etsng_code order by id limit 1');
            pa.cargoResult[0].cargoSpec=[{code:etsng,qty:125}];
        }
        if (mode==='NONE') {
            const other = sql("select code from railway_carriage c where not exists(select 1 from railway_carriage_owner o where o.railway_carriage_id=c.id) limit 1");
            await send({...pa,cargoResult:[{...pa.cargoResult[0],transportNumber:other}]},'INVALID');
        }
        await send(pa);
        if (!rail) {
            await send(pa);
            assert.equal(sql("select order_status from shipping_order where id='"+order+"'"),'COMPLETED');
            assert.equal(audit(a,'DEPARTURE'),'2026-10-02 10:11:12');
            await x.cancel('shipping',order);
            console.log('PASS NONE_CONTAINER: one empty container, planned owner, duplicate and cancellation');
            continue;
        }
        assert.equal(audit(a,'DEPARTURE'),'2026-10-02 10:11:12');
        assert.equal(sql("select order_status from shipping_order where id='"+order+"'"),'CONFIRMED');
        await Promise.all([send(pb),send(pb)]);
        assert.equal(sql("select order_status from shipping_order where id='"+order+"'"),'COMPLETED');
        assert.equal(audit(b,'DEPARTURE'),'2026-10-03 10:11:12');
        assert.equal(sql("select count(*) from container_owner_history_view where order_id='"+order+"' and operation_type='DEPARTURE'"),'2');
        if (rail) assert.equal(wagonStatus(),'DEPARTED');
        if (rail) assert.equal(sql("select count(*) from shipping_order_railway_carriage where shipping_order_id='"+order+"'"),'1');
        if (mode==='NONE') {
            assert.equal(sql("select wight_net=125 from shipping_order_container_item where shipping_order_container_id='"+pa._id+"'"),'t');
            assert.equal(sql("select seal_numbers from shipping_order_container where id='"+pa._id+"'"),'SEAL01');
        }
        await x.cancel('shipping',order);
        assert.equal(sql("select status from container_owner where container_id='"+a+"'"),'ON_TERMINAL');
        assert.equal(wagonStatus(),'ON_TERMINAL');
        console.log('PASS '+mode+' creation, per-container time, partial result, duplicate, completion and cancellation');
    }
    assert.equal(sql("select to_regclass('container_movement') is null"),'t');
}
main().catch(e=>{console.error(e);process.exitCode=1});
