// Mutating checks are restricted to this isolated restored database and backend.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db=process.env.STORAGE_TEST_DB||'billing_stock_history_test',port=db==='billing_storage_sources_test'?'8205':db==='billing_storage_view_test'?'8204':'8203',base=(process.env.TEST_API_HOST||'http://127.0.0.1')+':'+port+'/api';
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();
const sql=q=>run(['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q]);
const json=q=>JSON.parse(sql(q)||'null');
assert.ok(['billing_stock_history_test','billing_storage_view_test','billing_storage_sources_test'].includes(db));
assert.equal(sql('select current_database()'),db);
const capture=path.join(__dirname,'../backups/stock-history-before.json');
function snapshot(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename not in ('flyway_schema_history','container_stock_reservation')");
 const hashes=Object.fromEntries(tables.map(t=>[t,sql(`select md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),'')) from "${t}" t`)]));
 const sequences=json("select json_agg(sequencename order by sequencename) from pg_sequences where schemaname='public'");
 const seq=Object.fromEntries(sequences.map(t=>[t,sql(`select last_value||':'||is_called from "${t}"`)]));
 const columns=json("select json_agg(t order by table_name,ordinal_position) from (select table_name,column_name,ordinal_position,data_type,is_nullable from information_schema.columns where table_schema='public' and table_name<>'container_stock_reservation')t");
 return {hashes,seq,columns};
}
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let v;try{v=JSON.parse(text)}catch{v=text}assert.equal(r.status,status,p+': '+text);return v;}
const stock=c=>json(`select row_to_json(o) from container_owner o where container_id='${c}'`);
const finish=(kind,id)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});
const cancel=(kind,id,status,expected=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus:status,reason:'Проверка восстановления по истории'},expected);
async function clock(date){const c=await api('/application-clock');return api('/application-clock','PUT',{date,version:c.version});}
async function main(){
 if(process.argv[2]==='capture'){
  assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'42');
  fs.mkdirSync(path.dirname(capture),{recursive:true});fs.writeFileSync(capture,JSON.stringify(snapshot()));console.log('PASS: V42 data, sequences and columns captured');return;
 }
 const inspect=JSON.parse(run(['inspect',db==='billing_storage_sources_test'?'billing-next-storage-sources-test':db==='billing_storage_view_test'?'billing-next-storage-view-test':'billing-next-stock-history-test']))[0];
 assert.ok(inspect.Config.Env.includes('DB_NAME='+db));assert.ok(inspect.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostPort===port));
 assert.ok(['43','44','45','46'].includes(sql('select max(version::int) from flyway_schema_history where success')));
 assert.equal(sql("select to_regclass('container_stock_reservation') is null"),'t');
 if(process.argv[2]==='migration'){
  assert.deepEqual(snapshot(),JSON.parse(fs.readFileSync(capture,'utf8')));
  console.log('PASS: V43 removes only reservation table; every remaining business row, sequence and column is unchanged');return;
 }
 const initialClock=await api('/application-clock');
 const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
 const owner=tariff.client_id,clients=await api('/references/clients'),other=clients.find(c=>c.id!==owner).id,party=clients.find(c=>c.id===owner).name;
 const area=(await api('/references/terminal-areas')).find(a=>a.code==='CONTAINER').id;
 const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true')));
 const logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
 async function generated(){const b=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);return sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${b.id}' limit 1`);}
 async function manual(kind,containers,newOwner=owner){return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:newOwner}:{}),arrivalAt:'2026-11-01T12:00:00',departureAt:'2026-11-01T12:00:00',consignor:party,consignee:party,containers:containers.map(containerId=>({containerId,empty:true,ownerClientId:newOwner}))},201);}
 async function confirm(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-11-01T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});}
 const previous=(c,id,type)=>sql(`select previous_stock_order('${c}','${id}','${type}')`);
 try {
  // A full old visit, then a second visit on an earlier working date.
  // A draft created first must not be treated as an earlier reservation.
  await clock('2095-05-10');const c=await generated();
  const earlierDraft=await manual('receiving',[c],other),r1=await manual('receiving',[c]);
  await confirm('receiving',r1.id);await finish('receiving',r1.id);
  const s1=await manual('shipping',[c]);await confirm('shipping',s1.id);await finish('shipping',s1.id);
  // Simulate preserved legacy history made with a calendar far in the future.
  sql(`update container_owner_history set created_at=created_at+interval '100 years' where container_id='${c}'`);
  const oldMaximum=sql(`select max(created_at)::text from container_owner_history where container_id='${c}'`);
  await clock('2095-05-01');await confirm('receiving',earlierDraft.id);
  assert.equal(previous(c,earlierDraft.id,'RECEIVING_ORDER'),r1.id);
  assert.equal(sql(`select (created_at>'${oldMaximum}'::timestamp)::text from container_owner_history where container_id='${c}' and order_id='${earlierDraft.id}'`),'true');
  assert.equal(sql(`select (occurred_at at time zone 'Europe/Moscow')::date from container_owner_history where order_id='${earlierDraft.id}'`),'2095-05-01');
  await cancel('receiving',earlierDraft.id,'CONFIRMED');
  assert.equal(stock(c).receiving_order_id,r1.id);assert.equal(stock(c).shipping_order_id,s1.id);assert.equal(stock(c).client_id,owner);assert.equal(stock(c).status,'DEPARTED');
  const r2=await manual('receiving',[c],other);await confirm('receiving',r2.id);await finish('receiving',r2.id);
  assert.equal(previous(c,r2.id,'RECEIVING_ORDER'),r1.id,'cancelled receipt is skipped');
  const s2=await manual('shipping',[c]);await confirm('shipping',s2.id);
  assert.equal(previous(c,s2.id,'SHIPPING_ORDER'),s1.id);await cancel('shipping',s2.id,'CONFIRMED');
  assert.equal(stock(c).shipping_order_id,s1.id);assert.equal(stock(c).client_id,other);
  const s3=await manual('shipping',[c]);await confirm('shipping',s3.id);await finish('shipping',s3.id);
  assert.equal(previous(c,s3.id,'SHIPPING_ORDER'),s1.id,'cancelled shipment is skipped');
  await cancel('shipping',s3.id,'COMPLETED');await cancel('receiving',r2.id,'COMPLETED');
  assert.equal(stock(c).receiving_order_id,r1.id);assert.equal(stock(c).shipping_order_id,s1.id);assert.equal(stock(c).client_id,owner);
  const p=json(`select json_agg(q) from (select p.*,h.occurred_at receiving_at from container_storage_period p join container_owner_history h on h.id=p.receiving_history_id where receiving_order_id='${r2.id}')q`);
  assert.equal(p.length,1);assert.equal(p[0].status,'CANCELLED');assert.match(p[0].receiving_at,/2095-05-01/);
  console.log('PASS: prior active documents and owner restored across repeated visits, cancelled orders skipped, draft creation order ignored, rewound calendar and future legacy timestamps supported');
  // Incomplete or duplicated history must fail atomically, including a multi-KTK order.
  await clock('2095-06-01');const c2=await generated(),r3=await manual('receiving',[c,c2],other);await confirm('receiving',r3.id);
  const before=[stock(c),stock(c2)],h=sql(`select id from container_owner_history where order_id='${r3.id}' and container_id='${c2}'`);
  sql(`update container_owner_history set operation_type='UNKNOWN' where id='${h}'`);
  assert.equal((await cancel('receiving',r3.id,'CONFIRMED',409)).code,'STOCK_HISTORY_REQUIRED');
  assert.deepEqual([stock(c),stock(c2)],before);assert.equal(sql(`select count(*) from order_cancellation where order_id='${r3.id}'`),'0');
  sql(`update container_owner_history set operation_type='RESERVE_RECEIVING' where id='${h}'`);
  const duplicate=crypto.randomUUID();
  sql(`insert into container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,operation_type,occurred_at) select '${duplicate}',container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,operation_type,occurred_at from container_owner_history where id='${h}'`);
  assert.equal((await cancel('receiving',r3.id,'CONFIRMED',409)).code,'STOCK_HISTORY_REQUIRED');assert.deepEqual([stock(c),stock(c2)],before);
  sql(`delete from container_owner_history where id='${duplicate}'`);
  const replies=await Promise.all([1,2].map(()=>cancel('receiving',r3.id,'CONFIRMED')));assert.equal(replies.length,2);
  assert.equal(stock(c).receiving_order_id,r1.id);assert.equal(stock(c).client_id,owner);
  assert.equal(stock(c2).receiving_order_id,null);assert.equal(stock(c2).client_id,other,'first receipt with null previous owner keeps its current owner');
  assert.equal(sql(`select count(*) from order_cancellation where order_id='${r3.id}'`),'1');
  assert.equal(sql(`select count(*) from container_owner_history where order_id='${r3.id}' and cancellation`),'2');
  assert.equal(sql(`select count(*) from (select container_id,created_at,count(*) from container_owner_history group by 1,2 having count(*)>1)t`),'0');
  console.log('PASS: missing/duplicate reservation history blocks whole batch; concurrent cancellation is idempotent; first receipt cancellation and unique recording order verified');
 } finally {await clock(initialClock.mode==='SYSTEM'?null:initialClock.date);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
