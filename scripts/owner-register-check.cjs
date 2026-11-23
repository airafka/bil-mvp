const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),{Buffer}=require('node:buffer');
const docker=process.env.DOCKER_EXE||'docker',pg='billing-register-owner-db',db='billing_register_owner_test',base='http://127.0.0.1:8355/api';
const network='billing-register-owner',task='register-owner';
const migrationsDirectory=path.join(__dirname,'../backend/src/main/resources/db/baseline');
const migrations=fs.readdirSync(migrationsDirectory).filter(n=>/^V\d+__.*\.sql$/.test(n)).sort((a,b)=>Number(a.match(/^V(\d+)/)[1])-Number(b.match(/^V(\d+)/)[1]));
const latestVersion=Number(migrations.at(-1).match(/^V(\d+)/)[1]);
const run=(a,input)=>execFileSync(docker,a,{input,encoding:'utf8',windowsHide:true,maxBuffer:80*1024*1024}).trim();
const sql=q=>run(['exec','-i',pg,'psql','-X','-U','billing','-d',db,'-qAt','-v','ON_ERROR_STOP=1'],q),json=q=>JSON.parse(sql(q));
const quote=s=>"'"+String(s).replaceAll("'","''")+"'",identifier=s=>'"'+s.replaceAll('"','""')+'"';
function guard(name){
 assert(['billing-register-owner-old','billing-register-owner-new'].includes(name),'Unexpected backend');
 const inspect=n=>JSON.parse(run(['inspect',n]))[0];
 const p=inspect(pg),i=inspect(name),n=JSON.parse(run(['network','inspect',network]))[0];
 assert.equal(n.Labels?.['billing.task'],task,'Network task label');
 for(const c of [p,i]){
  assert.equal(c.Config.Labels?.['billing.task'],task,'Container task label');
  assert.deepEqual(Object.keys(c.NetworkSettings.Networks),[network],'Exactly one isolated network');
  assert.equal(c.State.Running,true,'Container must be running');
  assert.equal(c.HostConfig.Privileged,false);assert.equal(c.HostConfig.NetworkMode,network);
  assert.equal((c.HostConfig.Binds||[]).length,0,'No bind mounts');
  assert.equal((c.HostConfig.VolumesFrom||[]).length,0,'No inherited mounts');
 }
 assert.equal((p.Mounts||[]).filter(m=>m.Type!=='tmpfs').length,0,'Database has no persistent mounts');
 assert.deepEqual(Object.keys(p.HostConfig.Tmpfs||{}),['/var/lib/postgresql/data'],'Only temporary PostgreSQL storage');
 assert.equal(Object.keys(p.HostConfig.PortBindings||{}).length,0,'Database has no published ports');
 assert(p.NetworkSettings.Networks[network].Aliases?.includes('db'),'Database owns db alias');
 assert.equal(i.Mounts.length,0,'Backend must not mount external configuration or storage');
 assert.equal(Object.keys(i.HostConfig.Tmpfs||{}).length,0);
 assert.deepEqual(i.Config.Entrypoint,['java','-jar','/app/app.jar']);assert.equal(i.Config.Cmd,null);
 assert.deepEqual(i.NetworkSettings.Ports['8080/tcp'],[{HostIp:'127.0.0.1',HostPort:'8355'}]);
 assert.deepEqual(i.HostConfig.PortBindings,{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'8355'}]});
 for(const e of i.Config.Env)assert(!/^(SPRING_DATASOURCE|SPRING_CONFIG|SPRING_APPLICATION_JSON|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|JAVA_OPTS)(=|_)/.test(e),'No datasource/config/Java overrides');
 const env=Object.fromEntries(i.Config.Env.map(e=>{const at=e.indexOf('=');return[e.slice(0,at),e.slice(at+1)];}));
 assert.equal(env.DB_HOST,'db');assert.equal(env.DB_PORT,'5432');assert.equal(env.DB_NAME,db);assert.equal(env.DB_USER,'billing');
 for(const c of Object.values(n.Containers||{})){
  assert([pg,'billing-register-owner-old','billing-register-owner-new'].includes(c.Name),'No other containers on test network');
  const peer=inspect(c.Name);if(c.Name!==pg)assert(!peer.NetworkSettings.Networks[network].Aliases?.includes('db'),'db alias is unique');
 }
 const expectedImage=process.env[name.endsWith('-old')?'OWNER_CHECK_OLD_IMAGE':'OWNER_CHECK_NEW_IMAGE'];
 if(expectedImage){assert.match(expectedImage,/^sha256:[a-f0-9]{64}$/,'Expected immutable image ID');assert.equal(i.Image,expectedImage,'Running backend is the intended release');}
 assert.equal(sql('select current_database()'),db);
 const ip=i.NetworkSettings.Networks[network].IPAddress;assert.match(ip,/^\d+\.\d+\.\d+\.\d+$/);
 const sessions=json(`select coalesce(json_agg(t),'[]') from (select datname,usename,application_name from pg_stat_activity where client_addr=${quote(ip)}::inet and backend_type='client backend')t`);
 assert(sessions.length>0,'Backend JDBC session required; wait for /actuator/health before running');
 for(const s of sessions){assert.equal(s.datname,db,'Actual backend database');assert.equal(s.usename,'billing','Actual backend role');assert.equal(s.application_name,'PostgreSQL JDBC Driver');}
 return {image:i.Image,address:ip};
}
function flywayChecksum(file){
 // Flyway CRC32: UTF-8 lines without line separators and without the initial BOM.
 const bytes=Buffer.from(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r\n|\n|\r/).join(''),'utf8');
 let crc=0xffffffff;for(const b of bytes){crc^=b;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)|0;
}
function verifyRelease(expected){
 const rows=json('select coalesce(json_agg(t order by installed_rank),\'[]\') from flyway_schema_history t');
 assert.equal(rows.length,expected,'Exactly the expected migration chain');
 for(let version=1;version<=expected;version++){
  const row=rows[version-1],file=migrations.find(f=>Number(f.match(/^V(\d+)/)[1])===version);
  assert(file,'Local release contains migration '+version);assert.equal(Number(row.version),version);assert.equal(row.success,true);
  assert.equal(row.script,file,'Migration filename');assert.equal(row.checksum,flywayChecksum(path.join(migrationsDirectory,file)),'Migration checksum '+version);
 }
}
function snapshot(){
 const tables=json("select json_agg(tablename order by tablename) from pg_tables where schemaname='public'");
 const sequences=json("select coalesce(json_agg(sequencename order by sequencename),'[]') from pg_sequences where schemaname='public'");
 const tableSql=tables.map(t=>`select ${quote(t)} name,coalesce((select json_agg(row_to_json(r) order by to_jsonb(r)::text) from public.${identifier(t)} r),'[]') rows`).join(' union all ');
 const sequenceSql=sequences.map(t=>`select ${quote(t)} name,(select row_to_json(r) from (select last_value,log_cnt,is_called from public.${identifier(t)})r) value`).join(' union all ');
 return json(`begin isolation level repeatable read read only;
  select json_build_object('tables',(select json_object_agg(name,rows) from (${tableSql})t),
   'sequences',${sequences.length?`(select json_object_agg(name,value) from (${sequenceSql})s)`:'\'{}\'::json'},
   'owners',(select coalesce(json_agg(o order by id),'[]') from container_owner_current o),
   'constraints',(select coalesce(json_agg(t order by table_name,name),'[]') from (select conrelid::regclass::text table_name,conname name,contype,condeferrable,condeferred,convalidated,pg_get_constraintdef(oid) definition from pg_constraint where connamespace='public'::regnamespace)t),
   'triggers',(select coalesce(json_agg(t order by table_name,name),'[]') from (select tgrelid::regclass::text table_name,tgname name,tgenabled,tgdeferrable,tginitdeferred,pg_get_triggerdef(oid) definition from pg_trigger where tgrelid in(select oid from pg_class where relnamespace='public'::regnamespace) and not tgisinternal)t));commit;`);
}
function compareMigration(before,after){
 // Compare the V59 snapshot using V65's identifiers, preserving every stored value.
 before.tables.container_period=before.tables.container_ownership_period;
 delete before.tables.container_ownership_period;
 for(const [table,oldColumn] of [['container_owner_history','storage_period_id'],['service_order_container','container_ownership_period_id']]){
  for(const row of before.tables[table]){
   row.container_period_id=row[oldColumn];
   delete row[oldColumn];
  }
 }
 const renameIdentifier=value=>value.replaceAll('container_ownership_period','container_period')
   .replaceAll('history_storage_period_fk','history_container_period_fk').replaceAll('storage_period_id','container_period_id');
 for(const metadata of [...before.constraints,...before.triggers]){
  for(const field of ['table_name','name','definition'])metadata[field]=renameIdentifier(metadata[field]);
 }
 assert.deepEqual(Object.keys(after.tables).sort(),Object.keys(before.tables).sort(),'No business tables added/dropped');
 const order=rows=>rows.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort();
 const eventsMovedToPlans=new Set();
 const originalPeriods=new Map(before.tables.container_period.map(p=>[p.id,p]));
 for(const plan of after.tables.container_period.filter(p=>p.plan_order_id)){
  const event=before.tables.container_owner_history.find(e=>e.id===originalPeriods.get(plan.id).start_container_owner_history_id);
  assert(event && event.order_type==='SERVICE_ORDER');
  assert.equal(plan.start_container_owner_history_id,null);
  assert.equal(plan.plan_order_id,event.order_id);
  assert.equal(plan.plan_at,event.occurred_at);
  eventsMovedToPlans.add(event.id);
 }
 for(const [table,rows] of Object.entries(before.tables)){
  if(table==='flyway_schema_history')continue;
  const comparable=table==='container_visit'
   ? json("select coalesce(json_agg(v),'[]') from container_visit_facts v") : after.tables[table];
  const actual=comparable.map(row=>{
   if(table==='container_owner'){
    const {client_id,...original}=row;
    const old=before.tables.container_owner.find(o=>o.id===row.id);
    const visit=before.tables.container_visit.find(v=>v.id===old.container_visit_id);
    assert.equal(row.receiving_order_id,old.receiving_order_id??visit?.receiving_order_id??null);
    return {...original,receiving_order_id:old.receiving_order_id,container_visit_id:old.container_visit_id};
   }
   if(table==='container_period'){
    const {plan_at,plan_order_id,...original}=row;
    if(plan_order_id)original.start_container_owner_history_id=originalPeriods.get(row.id).start_container_owner_history_id;
    return original;
   }
   if(table==='service_order'){
    const {source_client_id,...original}=row;
    const owners=new Set(before.tables.service_order_container.filter(link=>link.service_order_id===row.id).map(link=>link.expected_client_id));
    const [source]=owners;
    const expected=row.status!=='DRAFT'&&owners.size===1&&source&&source!==row.client_id?source:null;
    assert.equal(source_client_id,expected,'V62 only infers an unambiguous transferor');
    return original;
   }
   return row;
  });
  const expected=table==='container_owner_history'?rows.filter(e=>!eventsMovedToPlans.has(e.id)):rows;
  assert.deepEqual(order(actual),order(expected),'Preserved contents and identifiers: '+table);
 }
 assert.deepEqual(after.sequences,before.sequences,'All sequence values and is_called unchanged');
 assert.deepEqual(order(after.tables.flyway_schema_history.filter(r=>Number(r.version)<=59)),order(before.tables.flyway_schema_history),'Existing Flyway records unchanged');
 const owners=new Map(before.owners.map(o=>[o.id,o.client_id]));
 for(const o of after.tables.container_owner){assert(owners.has(o.id));assert.equal(o.client_id,owners.get(o.id),'Owner migrated before any API refresh');}
 const formerVisitChecks=new Set(['container_visit_check','container_visit_check1','container_visit_check2','container_visit_check4','container_visit_check5']);
 for(const old of before.constraints.filter(c=>c.name!=='container_owner_visit_fk' && !(c.table_name==='container_visit' && formerVisitChecks.has(c.name))))assert(after.constraints.some(c=>JSON.stringify(c)===JSON.stringify(old)),'Existing constraint preserved: '+old.name);
 assert(after.constraints.some(c=>c.name==='container_visit_receiving_source' && c.convalidated));
 assert.deepEqual(order(after.triggers.filter(t=>t.name!=='actual_transfer_date')),order(before.triggers),'Existing triggers preserved');
 assert(after.triggers.some(t=>t.name==='actual_transfer_date'));
 assert.equal(sql("select attnotnull from pg_attribute where attrelid='container_owner'::regclass and attname='client_id'"),'t');
 assert(after.constraints.some(c=>c.table_name==='container_owner'&&c.contype==='f'&&c.convalidated&&c.definition==='FOREIGN KEY (client_id) REFERENCES client(id)'),'Validated owner FK');
 assert.equal(sql('select count(*) from container_owner o join container_owner_effective e using(id) where o.client_id is distinct from e.client_id'),'0');
}
function repair(){
 guard('billing-register-owner-new');verifyRelease(latestVersion);assert(latestVersion>=61,'V61 must be applied');
 const file=migrations.find(f=>/^V61__/.test(f));assert(file,'V61 migration file is required');
 const migration=fs.readFileSync(path.join(migrationsDirectory,file),'utf8');
 assert(!/^\s*(COMMIT|ROLLBACK)\s*;/mi.test(migration),'Repair test requires a transaction-safe migration');
 const before=snapshot();let result;
 try {
  result=json(`begin;
   set local lock_timeout='5s';set local statement_timeout='60s';
   create temporary table audit_v61_target on commit drop as
    select sc.id,sc.container_id,o.client_id expected_owner,alternative.id stale_owner
    from shipping_order_container sc join shipping_order s on s.id=sc.shipping_order_id
    join container_owner o on o.container_id=sc.container_id
    cross join lateral(select id from client where id<>o.client_id order by id limit 1) alternative
    where s.order_status='DRAFT' and sc.owner_container_id is not distinct from o.client_id
    order by sc.id limit 1;
   do $$ begin
    if (select count(*) from audit_v61_target)<>1 then raise exception 'V61 repair test needs one existing draft with a registered owner';end if;
    if exists(select 1 from shipping_order_container sc join shipping_order s on s.id=sc.shipping_order_id
     join container_owner o on o.container_id=sc.container_id where s.order_status='DRAFT' and sc.owner_container_id is distinct from o.client_id)
     then raise exception 'V61 repair test requires no pre-existing stale drafts';end if;
    if not exists(select 1 from shipping_order_container sc join shipping_order s on s.id=sc.shipping_order_id where s.order_status in ('CONFIRMED','COMPLETED'))
     then raise exception 'V61 repair test needs frozen shipment rows';end if;
   end $$;
   create function pg_temp.audit_v61_snapshot() returns jsonb language plpgsql as $$
    declare captured jsonb:='{"tables":{},"sequences":{}}';entry record;contents jsonb;
    begin
     for entry in select schemaname,tablename from pg_tables where schemaname='public' order by tablename loop
      execute format('select coalesce(jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text),''[]''::jsonb) from %I.%I source_row',entry.schemaname,entry.tablename) into contents;
      captured:=jsonb_set(captured,array['tables',entry.tablename],contents);
     end loop;
     for entry in select schemaname,sequencename from pg_sequences where schemaname='public' order by sequencename loop
      execute format('select to_jsonb(sequence_value) from (select last_value,log_cnt,is_called from %I.%I) sequence_value',entry.schemaname,entry.sequencename) into contents;
      captured:=jsonb_set(captured,array['sequences',entry.sequencename],contents);
     end loop;
     return captured;
    end $$;
   create temporary table audit_v61_pristine on commit drop as select pg_temp.audit_v61_snapshot() value;
   create temporary table audit_v61_changes(id uuid,before_row jsonb,after_row jsonb) on commit drop;
   create function pg_temp.audit_v61_record_update() returns trigger language plpgsql as $$ begin
    insert into pg_temp.audit_v61_changes values(old.id,to_jsonb(old),to_jsonb(new));return null;
   end $$;
   create trigger audit_v61_repair_test after update on shipping_order_container for each row execute function pg_temp.audit_v61_record_update();
   do $$ declare changed integer;begin
    update shipping_order_container sc set owner_container_id=t.stale_owner from audit_v61_target t where sc.id=t.id;
    get diagnostics changed=row_count;
    if changed<>1 then raise exception 'V61 fixture did not corrupt exactly one draft';end if;
   end $$;
   truncate table audit_v61_changes;
   ${migration}
   set constraints all immediate;
   do $$ declare change record;target record;begin
    if (select count(*) from audit_v61_changes)<>1 then raise exception 'V61 must update exactly the intentionally stale row';end if;
    select * into strict change from audit_v61_changes;select * into strict target from audit_v61_target;
    if change.id<>target.id or change.before_row->>'owner_container_id' is distinct from target.stale_owner::text
      or change.after_row->>'owner_container_id' is distinct from target.expected_owner::text
      or (change.before_row-'owner_container_id') is distinct from (change.after_row-'owner_container_id')
     then raise exception 'V61 repair changed a wrong row, owner UUID or additional fields';end if;
    if pg_temp.audit_v61_snapshot() is distinct from (select value from audit_v61_pristine)
     then raise exception 'V61 repair changed other business data, history, frozen rows or sequences';end if;
   end $$;
   select json_build_object('migration',${quote(file)},'repairedRows',(select count(*) from audit_v61_changes),
    'changedFields',json_build_array('owner_container_id'),'rowId',t.id,'staleOwner',t.stale_owner,'restoredOwner',t.expected_owner,
    'frozenRowsChecked',(select count(*) from shipping_order_container sc join shipping_order s on s.id=sc.shipping_order_id where s.order_status in ('CONFIRMED','COMPLETED')),
    'allBusinessTablesAndSequencesMatchPristine',true) from audit_v61_target t;
   rollback;`);
 } finally {
  // A psql error closes its connection and rolls back as well. Check both paths.
  assert.deepEqual(snapshot(),before,'Repair test rolled back every row, sequence, constraint and trigger');
 }
 console.log('PASS V61 exact repair and rollback: '+JSON.stringify(result));return result;
}
async function api(p,method='GET',body,status=200){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.equal(r.status,status,p+': '+text);return text?JSON.parse(text):null;}
async function clock(date){const c=await api('/application-clock');await api('/application-clock','PUT',{date,version:c.version});}
async function init(name){guard(name);verifyRelease(name.endsWith('-old')?59:latestVersion);
const tariff=json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
const clients=await api('/references/clients'),a=tariff.client_id,[b,c]=clients.filter(x=>x.id!==a).slice(0,2).map(x=>x.id),party=clients.find(x=>x.id===a).name;
const area=(await api('/references/terminal-areas')).find(x=>x.code==='CONTAINER').id;
const catalogs=await Promise.all(['carriers','drivers','vehicles'].map(k=>api('/transport-catalogs/'+k+'?activeOnly=true'))),logistics={carrierId:catalogs[0][0].id,driverId:catalogs[1][0].id,vehicleId:catalogs[2][0].id};
async function generated(){const bill=await api('/waybills/generate','POST',{standard20:0,standard40:1},201);return sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${bill.id}' limit 1`);}
async function transport(kind,ktk,owner=a){return api('/'+kind+'-orders','POST',{clientId:a,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',arrivalAt:'2026-09-15T12:00:00',departureAt:'2026-09-15T12:00:00',consignor:party,consignee:party,...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),containers:[ktk].flat().map(containerId=>({containerId,empty:true,ownerClientId:owner}))},201);}
async function confirm(kind,id){const r=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:'2026-09-15T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+r.route.id+'/confirm','POST',{});return r.route.id;}
const finish=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'},status);
async function arrival(ktk,owner=a,completed=true){ktk=ktk||await generated();const r=await transport('receiving',ktk,owner);await confirm('receiving',r.id);if(completed)await finish('receiving',r.id);return {ktk,receiving:r.id};}
async function ship(ktk,completed=true){const r=await transport('shipping',ktk);await confirm('shipping',r.id);if(completed)await finish('shipping',r.id);return r.id;}
async function transfer(ktk,next,date){const id=(await api('/service-orders','POST',{clientId:next,service:'CHANGE_OWNER',effectiveDate:date,containerOwnerIds:[sql(`select id from container_owner where container_id='${ktk}'`)]},201)).order.id;await api('/service-orders/'+id+'/accept','POST');return id;}
const report=ktk=>api('/container-storage-periods?size=100&query='+sql(`select code from container where id='${ktk}'`));
const cancel=(kind,id,status=200)=>api('/'+kind+'-orders/'+id+'/cancellation','POST',{expectedStatus:sql(`select order_status from ${kind}_order where id='${id}'`)},status);
return {a,b,c,generated,transport,confirm,finish,arrival,ship,transfer,report,cancel};}
async function capture(){
 const captured={};
 async function bytes(p){const r=await fetch(base+p);assert.equal(r.status,200,p);const body=Buffer.from(await r.arrayBuffer());captured[p]={bytes:body.length,base64:body.toString('base64')};return body;}
 for(const status of ['ACTIVE','ALL']){
  let pages=1;for(let page=0;page<pages;page++){
   const p=`/container-storage-periods?size=100&status=${status}&page=${page}`;
   const response=JSON.parse((await bytes(p)).toString('utf8'));pages=response.totalPages;
  }
 }
 for(const p of ['/container-storage-periods/export','/container-storage-periods/export?status=CLOSED'])await bytes(p);
 return captured;
}
function compareBytes(before,after){
 assert.deepEqual(Object.keys(after),Object.keys(before),'Same report pages and CSV exports');
 for(const p of Object.keys(before)){
  const expected=Buffer.from(before[p].base64,'base64'),actual=Buffer.from(after[p].base64,'base64');
  assert.equal(expected.length,before[p].bytes);assert.equal(actual.length,after[p].bytes);
  assert(expected.equals(actual),'Response bytes unchanged, including BOM/encoding: '+p);
 }
}
const count=(table,k)=>Number(sql(`select count(*) from ${table} where container_id='${k}'`));
const owner=k=>sql(`select client_id from container_owner_current where container_id='${k}'`);

// init() verifies the whole isolated stack before its first API access.
const physical=k=>sql(`select client_id from container_owner where container_id='${k}'`);
const stable=()=>json("select json_build_object('visits',(select json_agg(t order by id) from container_visit t),'periods',(select json_agg(t order by id) from container_period t),'history',(select json_agg(t order by id) from container_owner_history t))");
async function expectOwner(k,id){
 const code=sql(`select code from container where id=${quote(k)}`),name=sql(`select name from client where id=${quote(id)}`);
 const response=await api('/container-owners?size=100&query='+encodeURIComponent(code)),rows=response.items.filter(r=>r.containerId===k);
 assert.equal(rows.length,1);assert.equal(rows[0].clientId,id,'Registry JSON owner ID');assert.equal(rows[0].clientName,name,'Registry JSON owner name');
 const lookup=await api('/container-owners/lookup','POST',{containerIds:[k]});assert.equal(lookup.length,1);
 assert.equal(lookup[0].containerId,k);assert.equal(lookup[0].ownerClientId,id,'Lookup JSON owner ID');assert.equal(lookup[0].ownerClientName,name);
 assert.equal(owner(k),id);assert.equal(physical(k),id);
}
function parseCsv(text){
 text=text.replace(/^\uFEFF/,'');const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const ch=text[i];
  if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(!quoted&&ch===';'){row.push(cell);cell='';}
  else if(!quoted&&(ch==='\r'||ch==='\n')){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
  else cell+=ch;
 }
 assert.equal(quoted,false);if(row.length||cell){row.push(cell);rows.push(row);}return rows;
}
async function expectStorage(k,expected,periodTable='container_period'){
 const code=sql(`select code from container where id=${quote(k)}`);
 const report=await api('/container-storage-periods?size=100&query='+encodeURIComponent(code));
 const assignments=json(`select coalesce(json_agg(t),'[]') from (select p.id,p.client_id,c.name from ${identifier(periodTable)} p join client c on c.id=p.client_id where p.container_id=${quote(k)})t`);
 const byId=new Map(assignments.map(p=>[p.id,p]));
 const actual=report.items.map(r=>{const p=byId.get(r.id);assert(p);assert.equal(r.containerId,k);assert.equal(r.ownerName,p.name);return {ownerClientId:p.client_id,storageDays:r.storageDays};});
 const sort=rows=>rows.slice().sort((a,b)=>a.ownerClientId.localeCompare(b.ownerClientId)||a.storageDays-b.storageDays);
 assert.deepEqual(sort(actual),sort(expected),'Storage days belong to the expected owners');
 const r=await fetch(base+'/container-storage-periods/export?query='+encodeURIComponent(code));assert.equal(r.status,200);
 const bytes=Buffer.from(await r.arrayBuffer());assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],'CSV UTF-8 BOM');
 const csv=parseCsv(bytes.toString('utf8'));for(const row of csv)assert.equal(row.length,17,'CSV column count');
 assert.equal(csv[0][0],'Номер КТК');assert.equal(csv[0][1],'Собственник КТК');assert.equal(csv[0][2],'Дней хранения');
 const expectedCsv=report.items.map(r=>[r.containerName,r.ownerName,r.storageDays]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const actualCsv=csv.slice(1).map(r=>[r[0],r[1],Number(r[2])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 assert.deepEqual(actualCsv,expectedCsv,'CSV agrees with JSON owner labels and days');
 return report;
}
async function seed(){const x=await init('billing-register-owner-old');
await clock('2026-09-15');const closed=await x.arrival();await clock('2026-09-17');await x.transfer(closed.ktk,x.b,'2026-09-17');await clock('2026-09-20');closed.shipping=await x.ship(closed.ktk);
await clock('2026-09-16');const exactBack=await x.arrival();await clock('2026-09-18');exactBack.transferB=await x.transfer(exactBack.ktk,x.b,'2026-09-18');await clock('2026-09-20');exactBack.transferC=await x.transfer(exactBack.ktk,x.c,'2026-09-17');
const pending=await x.arrival(undefined,x.b,false),cancelled=await x.arrival(undefined,x.c,false);await x.cancel('receiving',cancelled.receiving);
const repeat=await x.arrival();repeat.shipping=await x.ship(repeat.ktk);repeat.pending=await x.arrival(repeat.ktk,x.b,false);
const open=await x.arrival();open.future=await x.transfer(open.ktk,x.b,'2026-09-25');open.shipping=await x.ship(open.ktk,false);
const terminal=await x.arrival();
assert.deepEqual(json('select json_agg(status order by status) from (select distinct status from container_owner)t'),['DEPARTED','EXPECTED','ON_TERMINAL','RESERVED_OUT']);
await expectStorage(closed.ktk,[{ownerClientId:x.a,storageDays:2},{ownerClientId:x.b,storageDays:4}],'container_ownership_period');
await expectStorage(exactBack.ktk,[{ownerClientId:x.a,storageDays:1},{ownerClientId:x.c,storageDays:1},{ownerClientId:x.b,storageDays:3}],'container_ownership_period');
fs.writeFileSync('owner-fixture.json',JSON.stringify({closed,pending,cancelled,repeat,open,terminal,exactBack}));
fs.writeFileSync('owner-before-api.json',JSON.stringify(await capture()));
fs.writeFileSync('owner-before-data.json',JSON.stringify(snapshot()));
console.log('PASS V59 fixtures: all four statuses asserted; exact A2/B4 and A1/C1/B3; complete database snapshot');}
async function check(){
 // This SQL comparison must precede init(), capture(), or any other /api access.
 // The first API request can repair an incorrect migration backfill.
 guard('billing-register-owner-new');verifyRelease(latestVersion);
 const before=JSON.parse(fs.readFileSync('owner-before-data.json')),after=snapshot();
 compareMigration(before,after);fs.writeFileSync('owner-after-migration-before-api.json',JSON.stringify(after));
 console.log(`PASS V59 -> V${latestVersion} before first API: ${Object.keys(before.tables).length} tables, ${Object.keys(before.sequences).length} sequences, owners/UUIDs/constraints/triggers`);
 const x=await init('billing-register-owner-new'),f=JSON.parse(fs.readFileSync('owner-fixture.json'));
 compareBytes(JSON.parse(fs.readFileSync('owner-before-api.json')),await capture());
 await expectOwner(f.terminal.ktk,x.a);await expectOwner(f.exactBack.ktk,x.b);
 await expectStorage(f.closed.ktk,[{ownerClientId:x.a,storageDays:2},{ownerClientId:x.b,storageDays:4}]);
 await expectStorage(f.exactBack.ktk,[{ownerClientId:x.a,storageDays:1},{ownerClientId:x.c,storageDays:1},{ownerClientId:x.b,storageDays:3}]);
 const history=await api('/containers/'+f.exactBack.ktk+'/owner-history');
 assert.equal(history.find(h=>h.orderId===f.exactBack.transferB).oldClientId,x.c,'Timeline predecessor after backdated insertion');
 assert.equal(sql(`select old_client_id from container_owner_history where order_id=${quote(f.exactBack.transferB)}`),x.a,'Original history owner snapshot retained');
 console.log('PASS all JSON report pages and both CSV exports byte-identical; owner mappings, registry and lookup verified');
await expectOwner(f.pending.ktk,x.b);assert.equal(count('container_visit',f.pending.ktk),0);assert.equal(count('container_period',f.pending.ktk),0);await x.cancel('receiving',f.pending.receiving);await expectOwner(f.pending.ktk,x.b);await expectOwner(f.cancelled.ktk,x.c);
await expectOwner(f.repeat.ktk,x.b);await x.cancel('receiving',f.repeat.pending.receiving);await expectOwner(f.repeat.ktk,x.a);assert.equal(count('container_visit',f.repeat.ktk),1);
const again=await x.arrival(f.repeat.ktk,x.c,false);await expectOwner(f.repeat.ktk,x.c);assert.equal(count('container_visit',f.repeat.ktk),1);await x.finish('receiving',again.receiving);assert.equal(count('container_visit',f.repeat.ktk),2);await x.cancel('receiving',again.receiving);await expectOwner(f.repeat.ktk,x.a);
console.log('PASS receiving: selected owner in EXPECTED; no premature visit; both cancellations restore owner; repeated visit isolated');
const draft=await x.transport('shipping',f.open.ktk,x.a);await expectOwner(f.open.ktk,x.a);await clock('2026-09-24');await expectOwner(f.open.ktk,x.a);assert.equal(sql(`select count(*) from container_owner_history where order_id='${f.open.future}'`),'0');await clock('2026-09-25');await expectOwner(f.open.ktk,x.b);assert.equal(sql(`select count(*) from container_owner_history where order_id='${f.open.future}'`),'1');const effective=stable();
assert.equal(sql(`select owner_container_id from shipping_order_container where shipping_order_id='${draft.id}'`),x.b);assert.equal(sql(`select owner_container_id from shipping_order_container where shipping_order_id='${f.open.shipping}'`),x.a);
await clock('2026-09-24');await expectOwner(f.open.ktk,x.a);await clock('2026-09-27');await expectOwner(f.open.ktk,x.b);assert.deepEqual(stable(),effective);await x.cancel('shipping',f.open.shipping);await expectOwner(f.open.ktk,x.b);await x.cancel('shipping',draft.id);
console.log('PASS dated transfer: calendar forward/back; only draft shipping follows owner; confirmed shipping frozen; one effective transfer recorded');
// Insert a historical owner between two existing assignments; latest owner stays B.
const back=await x.arrival();await clock('2026-09-30');await x.transfer(back.ktk,x.b,'2026-09-29');await x.transfer(back.ktk,x.c,'2026-09-28');await expectOwner(back.ktk,x.b);await expectStorage(back.ktk,[{ownerClientId:x.a,storageDays:1},{ownerClientId:x.c,storageDays:1},{ownerClientId:x.b,storageDays:2}]);
await clock('2026-09-28');await expectOwner(back.ktk,x.c);await clock('2026-09-27');await expectOwner(back.ktk,x.a);await clock('2026-09-30');await expectOwner(back.ktk,x.b);
console.log('PASS backdated insertion: A27, C28, B29; owners and report recalculate on calendar changes');
const same=await x.arrival();await x.transfer(same.ktk,x.b,'2026-09-30');await expectOwner(same.ktk,x.b);await x.ship(same.ktk);await expectOwner(same.ktk,x.b);
const early=await x.arrival();const future=await x.transfer(early.ktk,x.b,'2026-10-05');await x.ship(early.ktk);await clock('2026-10-05');await expectOwner(early.ktk,x.a);assert.equal(sql(`select result_status from service_order_container where service_order_id='${future}'`),'SKIPPED');
const withdraw=await x.arrival();let next=await x.transfer(withdraw.ktk,x.b,'2026-10-07');await api('/service-orders/'+next+'/withdraw','POST');await clock('2026-10-08');await expectOwner(withdraw.ktk,x.a);
await api('/service-orders/'+next,'PUT',{id:next,service:'CHANGE_OWNER',effectiveDate:'2026-10-10'});await api('/service-orders/'+next+'/accept','POST');await clock('2026-10-10');await expectOwner(withdraw.ktk,x.b);
console.log('PASS same-day receiving/transfer/shipping; shipping revokes future; withdrawal and rescheduling');
// At-most-once confirmation under concurrent requests.
const race=await x.arrival();const id=(await api('/service-orders','POST',{clientId:x.b,service:'CHANGE_OWNER',effectiveDate:'2026-10-10',containerOwnerIds:[sql(`select id from container_owner where container_id='${race.ktk}'`)]},201)).order.id;
const statuses=await Promise.all([1,2].map(()=>fetch(base+'/service-orders/'+id+'/accept',{method:'POST'}).then(r=>r.status)));assert.deepEqual(statuses.sort(),[200,409]);await expectOwner(race.ktk,x.b);assert.equal(sql(`select count(*) from container_owner_history where order_id='${id}'`),'1');
const version=sql(`select version from container_owner where container_id='${race.ktk}'`),audit=stable();await Promise.all(Array.from({length:8},()=>api('/container-owners?size=100')));assert.equal(sql(`select version from container_owner where container_id='${race.ktk}'`),version);assert.deepEqual(stable(),audit);
console.log('PASS concurrent confirmation: exactly one operation; repeated reads do not write unchanged register/history');
// Stop only this test backend and simulate time passing; first API access catches up.
const restart=await x.arrival();const restartOrder=await x.transfer(restart.ktk,x.b,'2026-10-12');assert.equal(sql(`select count(*) from container_owner_history where order_id='${restartOrder}'`),'0');run(['stop','billing-register-owner-new']);sql("update application_clock set business_date='2026-10-12',version=version+1 where id=1");assert.equal(physical(restart.ktk),x.a);run(['start','billing-register-owner-new']);
for(let n=0;n<45;n++){try{if((await fetch('http://127.0.0.1:8355/actuator/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
await expectOwner(restart.ktk,x.b);assert.equal(sql(`select count(*) from container_owner_history where order_id='${restartOrder}'`),'1');
// System clock mode must refresh a stale stored snapshot on access, too.
await clock(null);const systemDate=(await api('/application-clock')).date;const yesterday=new Date(systemDate+'T12:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);await clock(yesterday.toISOString().slice(0,10));const sys=await x.arrival();await x.transfer(sys.ktk,x.b,systemDate);sql('update application_clock set business_date=null,version=version+1 where id=1');assert.equal(physical(sys.ktk),x.a);await expectOwner(sys.ktk,x.b);
console.log('PASS downtime/restart and system-date access: owner refreshed without scheduler; due history recorded once');
// Rail receiving: no visit at confirmation; cancellation releases the bill for reuse.
const service=(await api('/comprehensive-service-orders/available-services'))[0];const tariff=json(`select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where complex_service_id='${service.id}' and active order by id limit 1)t`);
const bill=await api('/waybills/generate','POST',{standard20:1,standard40:0},201);const req={complexServiceId:service.id,clientId:tariff.client_id,contractId:tariff.contract_id,defaultContainerOwnerId:x.a,waybillIds:[bill.id]};
async function section(root,action){return api('/comprehensive-service-orders/'+root+'/'+(action==='PREPARE_TRANSPORT'?'prepare-transport':'complete-section'),'POST',{section:'INITIAL_RECEIVING',...(action==='PREPARE_TRANSPORT'?{}:{action})});}
let rail=await api('/comprehensive-service-orders','POST',req,201);const railK=rail.receivingOrder.containers[0].containerId;
await section(rail.order.id,'PREPARE_TRANSPORT');await section(rail.order.id,'CONFIRM_ROUTES');assert.equal(count('container_visit',railK),0);assert.equal(count('container_period',railK),0);
for(const shipping of rail.shippingOrders)await x.cancel('shipping',shipping.id);await x.cancel('receiving',rail.receivingOrder.id);assert.equal(count('container_visit',railK),0);
rail=await api('/comprehensive-service-orders','POST',{...req,defaultContainerOwnerId:x.b},201);await section(rail.order.id,'PREPARE_TRANSPORT');await section(rail.order.id,'CONFIRM_ROUTES');await section(rail.order.id,'COMPLETE_ORDERS');assert.equal(count('container_visit',railK),1);assert.equal(count('container_period',railK),1);assert.equal(owner(railK),x.b);assert.equal(sql(`select count(*) from container_visit where container_id='${railK}' and waybill_container_id is not null`),'1');
console.log('PASS: railway confirmation has no physical visit, cancellation/reused waybill, actual rail receipt with one ownership assignment');

await expectOwner(railK,x.b);
const completed=await x.arrival();const sent=await x.ship(completed.ktk);const periodCount=count('container_period',completed.ktk);await x.cancel('shipping',sent);await expectOwner(completed.ktk,x.a);assert.equal(count('container_period',completed.ktk),periodCount);assert.equal(sql("select status from container_owner where container_id='"+completed.ktk+"'"),'ON_TERMINAL');
console.log('PASS actual shipping cancellation preserves owner and assignments');
console.log('ALL OWNER REGISTER CHECKS PASSED');}
module.exports={init,api,sql,json,clock,guard,snapshot,expectOwner,expectStorage,repair};
if(require.main===module){
 const mode=process.argv[2];assert(['seed','check','repair'].includes(mode),'Usage: node owner-register-check.cjs seed|check|repair');
 (mode==='seed'?seed():mode==='check'?check():Promise.resolve().then(repair)).catch(e=>{console.error(e);process.exitCode=1;});
}
