const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_wagon_test',base='http://127.0.0.1:8194/api';
const inspected=JSON.parse(execFileSync(docker,['inspect','billing-next-wagon-test'],{encoding:'utf8',windowsHide:true}))[0];assert.ok(inspected.Config.Env.includes('DB_NAME='+db));assert.ok(inspected.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort==='8194'));
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true}).trim();assert.equal(sql('select current_database()'),db);const json=q=>JSON.parse(sql(q));
async function raw(p,method='GET',body){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,value:await r.json()}}
async function api(p,method='GET',body,status=200){const r=await raw(p,method,body);assert.equal(r.status,status,p+': '+JSON.stringify(r.value));return r.value}
const preview=(ids,extra={})=>api('/waybills/placement/preview','POST',{waybillIds:ids,...extra});
const payload=(layout,targets={})=>({waybillIds:layout.waybills.map(b=>b.id),wagonIds:layout.wagons.map(w=>w.id),version:layout.version,assignments:layout.containers.filter(c=>c.selected).map(c=>({rowId:c.rowId,wagonId:targets[c.rowId]||c.wagonId}))});
const save=(l,t={},status=200)=>api('/waybills/placement','PUT',payload(l,t),status);
async function fixture(twenty=4,forty=0){
 const original=await api('/waybills/generate','POST',{standard20:twenty,standard40:forty},201);
 const rows=json("select json_agg(t order by t.wagon,t.cid) from (select wc.container_id as cid,wc.weight as gross,wc.net_weight as net,rc.railway_carriage_id as wagon from waybill_container wc join waybill_railway_carriage rc on rc.id=wc.waybill_railway_carriage_id where rc.waybill_id='"+original.id+"')t");
 const cargo=sql("select etsng_code_id from waybill_product where waybill_id='"+original.id+"' limit 1"),tag='ED'+crypto.randomUUID().replaceAll('-','').slice(0,8);
 const bills=[];for(let i=0;i<rows.length;i++)bills.push(await api('/waybills','POST',{number:tag+'-'+(i+1),departureStation:1001,destinationStation:2001,payer:'ФИТ',products:[{etsngCodeId:cargo,weight:String(rows[i].net)}],railwayCarriages:[{railwayCarriageId:rows[i].wagon,containers:[{containerId:rows[i].cid,grossWeight:String(rows[i].gross),netWeight:String(rows[i].net),owner:'Исходный собственник '+i}]}]},201));
 // Fixture only: replace the generated multi-KTK bill with independent bills for each KTK.
 sql("delete from waybill where id='"+original.id+"'");
 return {ids:bills.map(b=>b.id),bills,tag,rows};
}
(async()=>{
 const f=await fixture(),l=await preview(f.ids);assert.equal(l.wagons.length,2);assert.equal(l.containers.length,4);assert.ok(l.containers.every(c=>c.selected));
 const candidates=await api('/waybills/placement/candidates?query='+f.tag+'&size=2');assert.equal(candidates.items.length,2);assert.equal(candidates.totalElements,4);assert.ok(candidates.items.every(c=>c.wagonCount===1&&c.containerCount===1));
 const first=l.containers[0],other=l.containers.find(c=>c.wagonId!==first.wagonId);assert.ok(other);
 const audit=()=>Number(sql("select count(*) from waybill_container_relocation where waybill_id in ('"+f.ids.join("','")+"')"));
 const identity=()=>json("select json_agg(t order by t.id) from (select wc.id,rc.waybill_id,wc.container_id,wc.weight,wc.net_weight,wc.owner,wc.owner_container_id,(select json_agg(z order by z.id) from waybill_zpu z where z.waybill_container_id=wc.id) as seals,(select json_agg(p order by p.id) from waybill_product p where p.waybill_id=rc.waybill_id) as products from waybill_container wc join waybill_railway_carriage rc on rc.id=wc.waybill_railway_carriage_id where rc.waybill_id in ('"+f.ids.join("','")+"'))t");
 // Give the first container a seal so the preservation assertion covers its child records too.
 const sealType=sql('select id from seal_type order by id limit 1');sql("insert into waybill_zpu(id,waybill_container_id,zpu,zpu_type) values(gen_random_uuid(),'"+first.rowId+"','0012345','"+sealType+"')");
 const before=identity();assert.equal((await save(l,{[first.rowId]:other.wagonId},409)).code,'WAGON_CAPACITY_EXCEEDED');assert.equal(audit(),0);assert.deepEqual(identity(),before);
 const swapped=await save(l,{[first.rowId]:other.wagonId,[other.rowId]:first.wagonId});assert.equal(audit(),2);assert.deepEqual(identity(),before);
 assert.equal(swapped.containers.find(c=>c.rowId===first.rowId).waybillNumber,first.waybillNumber);assert.equal(swapped.containers.find(c=>c.rowId===first.rowId).wagonId,other.wagonId);
 assert.equal((await save(l,{},409)).code,'WAYBILL_PLACEMENT_CHANGED');await save(swapped);assert.equal(audit(),2,'no-change save produces no duplicate history');
 let partial=await preview([first.waybillId]);assert.equal(partial.containers.length,1);assert.ok(partial.containers.every(c=>c.selected));
 partial=await preview([first.waybillId],{wagonIds:partial.wagons.map(w=>w.id),expectedVersion:partial.version,addWagonId:first.wagonId});assert.equal(partial.containers.length,1);
 const forged=payload(partial);forged.assignments.push({rowId:other.rowId,wagonId:first.wagonId});assert.equal((await api('/waybills/placement','PUT',forged,409)).code,'INVALID_PLACEMENT');
 const outsideBefore=sql("select to_jsonb(wc)::text from waybill_container wc where id='"+other.rowId+"'");
 const scoped=await save(partial,{[first.rowId]:first.wagonId});assert.equal(scoped.containers[0].wagonId,first.wagonId);
 assert.equal(sql("select to_jsonb(wc)::text from waybill_container wc where id='"+other.rowId+"'"),outsideBefore);
 // Unselected documents do not participate in capacity or the editor version, even on the same wagon.
 sql("update waybill_container set weight=weight+1 where id='"+other.rowId+"'");
 const unchanged=await preview([first.waybillId],{wagonIds:scoped.wagons.map(w=>w.id)});assert.equal(unchanged.version,scoped.version);await save(scoped);
 sql("update waybill_container set weight=weight-1 where id='"+other.rowId+"'");
 const fresh=await preview(f.ids),back={[first.rowId]:first.wagonId,[other.rowId]:other.wagonId};const outcomes=await Promise.all([raw('/waybills/placement','PUT',payload(fresh,back)),raw('/waybills/placement','PUT',payload(fresh,back))]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
 console.log('PASS: multi-bill/multi-wagon layout, shared wagon, swap, identity/cargo/seal preservation, selected-scope overload rollback, unrelated loads ignored/untouched, stale/concurrent edits');
 // Empty platform can be added, and source associations disappear only after all their KTK move.
 const empty=await fixture(0,2),emptyWagon=empty.rows[0].wagon;for(const id of empty.ids)sql("delete from waybill where id='"+id+"'");
 let extended=await preview(f.ids);extended=await preview(f.ids,{wagonIds:extended.wagons.map(w=>w.id),expectedVersion:extended.version,addWagonId:emptyWagon});
 const sourceWagon=extended.containers[0].wagonId,moving=extended.containers.filter(c=>c.wagonId===sourceWagon);assert.equal(moving.length,2);
 extended=await save(extended,Object.fromEntries(moving.map(c=>[c.rowId,emptyWagon])));assert.equal(extended.wagons.length,3);assert.equal(extended.containers.filter(c=>c.wagonId===sourceWagon).length,0);
 assert.equal(sql("select count(*) from waybill_railway_carriage where railway_carriage_id='"+sourceWagon+"' and waybill_id in ('"+f.ids.join("','")+"')"),'0');
 console.log('PASS: adding an empty wagon and cleaning empty document associations');
 // Moving between two waybills on the same physical wagon changes only the WC link.
 const cross=await fixture(0,4),cl=await preview(cross.ids),ca=cl.containers[0],cb=cl.containers.find(c=>c.wagonId===ca.wagonId&&c.rowId!==ca.rowId);
 const crossPayload=payload(cl);crossPayload.assignments.find(a=>a.rowId===ca.rowId).waybillId=cb.waybillId;
 const frozen=()=>json("select json_agg(t order by t.id) from (select wc.id,to_jsonb(wc)-'waybill_railway_carriage_id' as data,(select jsonb_agg(z order by z.id) from waybill_zpu z where z.waybill_container_id=wc.id) as seals from waybill_container wc where wc.id in ('"+cl.containers.map(c=>c.rowId).join("','")+"'))t");
 const originalRows=frozen(),oldLink=sql("select waybill_railway_carriage_id from waybill_container where id='"+ca.rowId+"'"),targetLink=sql("select waybill_railway_carriage_id from waybill_container where id='"+cb.rowId+"'");
 const outside=structuredClone(crossPayload);outside.assignments[0].waybillId=f.ids[0];assert.equal((await api('/waybills/placement','PUT',outside,409)).code,'INVALID_PLACEMENT');
 const product=crypto.randomUUID();sql("insert into waybill_product(id,waybill_id,etsng_code_id,weight) select '"+product+"',waybill_id,etsng_code_id,weight from waybill_product where waybill_id='"+cb.waybillId+"' limit 1");
 assert.equal((await api('/waybills/placement','PUT',crossPayload,409)).code,'WAYBILL_MULTIPLE_PRODUCTS');sql("delete from waybill_product where id='"+product+"'");
 const moved=await api('/waybills/placement','PUT',crossPayload);assert.equal(moved.containers.find(c=>c.rowId===ca.rowId).waybillId,cb.waybillId);assert.equal(moved.containers.find(c=>c.rowId===ca.rowId).wagonId,ca.wagonId);
 assert.notEqual(oldLink,targetLink);assert.equal(sql("select waybill_railway_carriage_id from waybill_container where id='"+ca.rowId+"'"),targetLink);assert.deepEqual(frozen(),originalRows);
 assert.equal(sql("select count(*) from waybill_container_relocation where waybill_container_id='"+ca.rowId+"' and waybill_id='"+ca.waybillId+"' and to_waybill_id='"+cb.waybillId+"' and from_railway_carriage_id=to_railway_carriage_id"),'1');
 await save(moved);assert.equal((await api('/waybills/placement','PUT',crossPayload,409)).code,'WAYBILL_PLACEMENT_CHANGED');
 const restore=payload(moved);restore.assignments.find(a=>a.rowId===ca.rowId).waybillId=ca.waybillId;const restored=await api('/waybills/placement','PUT',restore);assert.equal(restored.containers.find(c=>c.rowId===ca.rowId).waybillId,ca.waybillId);
 const swap=payload(restored);swap.assignments.find(a=>a.rowId===ca.rowId).waybillId=cb.waybillId;swap.assignments.find(a=>a.rowId===cb.rowId).waybillId=ca.waybillId;const cs=await api('/waybills/placement','PUT',swap);assert.equal(cs.containers.find(c=>c.rowId===cb.rowId).waybillId,ca.waybillId);assert.deepEqual(frozen(),originalRows);
 console.log('PASS: same-wagon waybill reassignment changes exactly WC foreign key, audit, stale/unknown destination guards, empty source return and swap, cargo invariant');
 // Existing draft delivery sees the change automatically, while its source container links remain intact.
 const service=(await api('/comprehensive-service-orders/available-services'))[0],tariff=json("select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='"+service.id+"' and active limit 1)t");
 const order=await api('/comprehensive-service-orders','POST',{clientId:tariff.client_id,contractId:tariff.contract_id,complexServiceId:service.id,defaultContainerOwnerId:tariff.client_id,waybillIds:f.ids},201);
 const draft=await preview(f.ids),one=draft.containers[0],two=draft.containers.find(c=>c.wagonId!==one.wagonId),withOwners=identity();await save(draft,{[one.rowId]:two.wagonId,[two.rowId]:one.wagonId});assert.deepEqual(identity(),withOwners);
 assert.equal(sql("select count(*) from shipping_order_source_container where comprehensive_service_order_id='"+order.order.id+"'"),'4');
 const sameDraft=await preview(f.ids),da=sameDraft.containers[0],dbrow=sameDraft.containers.find(c=>c.wagonId===da.wagonId&&c.rowId!==da.rowId);
 const sourceLinks=sql("select json_agg(t order by to_jsonb(t)::text) from shipping_order_source_container t where comprehensive_service_order_id='"+order.order.id+"'");
 const draftPayload=payload(sameDraft);draftPayload.assignments.find(a=>a.rowId===da.rowId).waybillId=dbrow.waybillId;draftPayload.assignments.find(a=>a.rowId===dbrow.rowId).waybillId=da.waybillId;await api('/waybills/placement','PUT',draftPayload);
 assert.equal(sql("select json_agg(t order by to_jsonb(t)::text) from shipping_order_source_container t where comprehensive_service_order_id='"+order.order.id+"'"),sourceLinks);
 const mixed=await preview([...f.ids,...cross.ids]),mismatch=payload(mixed);mismatch.assignments.find(a=>a.rowId===da.rowId).waybillId=cross.ids[0];assert.equal((await api('/waybills/placement','PUT',mismatch,409)).code,'WAYBILL_RECEIVING_MISMATCH');
 console.log('PASS: same-draft reassignment preserves source links; cross-delivery reassignment rejected');
 const stale=await preview(f.ids);await api('/comprehensive-service-orders/'+order.order.id+'/prepare-transport','POST',{section:'INITIAL_RECEIVING'});await api('/comprehensive-service-orders/'+order.order.id+'/complete-section','POST',{section:'INITIAL_RECEIVING',action:'CONFIRM_ROUTES'});
 assert.equal((await save(stale,{},409)).code,'WAYBILL_PLACEMENT_LOCKED');assert.equal((await api('/waybills/placement/candidates?query='+f.tag)).totalElements,0);
 const ui=await fixture(0,4);fs.writeFileSync('backups/wagon-fixtures.json',JSON.stringify({...ui,db}));
 console.log('PASS: draft delivery composition and owners preserved, confirmation blocks editing; UI fixtures ready');
})().catch(e=>{console.error(e);process.exitCode=1});
