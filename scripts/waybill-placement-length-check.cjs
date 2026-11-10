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
 const f=await fixture(8),initial=await preview(f.ids);assert.equal(initial.wagons.length,4);
 const target=initial.wagons[0],others=initial.wagons.slice(1),six=initial.containers.slice(0,6),remaining=initial.containers.slice(6);
 const assignSql=(c,wagon)=>{let link=sql("select id from waybill_railway_carriage where waybill_id='"+c.waybillId+"' and railway_carriage_id='"+wagon+"' limit 1");if(!link){link=crypto.randomUUID();sql("insert into waybill_railway_carriage(id,waybill_id,railway_carriage_id) values('"+link+"','"+c.waybillId+"','"+wagon+"')")};sql("update waybill_container set waybill_railway_carriage_id='"+link+"' where id='"+c.rowId+"'")};
 sql("update railway_carriage set type_id=(select id from railway_carriage_type where code='PLATFORM_80' limit 1),lifting_capacity=1 where id='"+target.id+"'");
 for(const c of six)assignSql(c,target.id);for(const c of remaining)assignSql(c,others[2].id);
 const extras={wagonIds:initial.wagons.map(w=>w.id)};
 let l=await preview(f.ids,extras);assert.equal(l.containers.filter(c=>c.wagonId===target.id).length,6);
 assert.equal((await save(l,{},409)).code,'WAGON_CAPACITY_EXCEEDED');
 assert.equal((await save(l,{[six[0].rowId]:others[0].id},409)).code,'WAGON_CAPACITY_EXCEEDED');
 l=await save(l,{[six[0].rowId]:others[0].id,[six[1].rowId]:others[1].id});assert.equal(l.containers.filter(c=>c.wagonId===target.id).length,4);assert.equal(l.wagons.find(w=>w.id===target.id).capacity,1);
 console.log('PASS: preview shows six KTK; 120/100ft rejected; four 20ft containers saved on 80ft with lifting capacity 1kg');
 // Keep the erroneous six-container source arrangement as a UI fixture, test DB only.
 for(const c of six)assignSql(c,target.id);
 const ui=await preview(f.ids,extras);assert.equal(ui.wagons.length,4);
 fs.writeFileSync('backups/wagon-length-fixtures.json',JSON.stringify({...f,db,target:target.id,empty:others.slice(0,2).map(w=>w.id),wagons:initial.wagons.map(w=>w.id)}));
})().catch(e=>{console.error(e);process.exitCode=1});
