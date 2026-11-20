// Explicit one-time operational reset. Never invoked by migrations or application startup.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db=process.argv[2],backup=path.resolve(process.argv[3]||''),mode=process.argv[4];
assert.ok(['billing_next','billing_storage_chain_release_test'].includes(db),'Unexpected database');
assert.ok(['--dry-run','--clear-all-operational-data'].includes(mode),'Explicit reset mode required');
assert.ok(fs.statSync(backup).isFile()&&fs.statSync(backup).size>10000);
assert.equal(fs.readFileSync(backup).subarray(0,5).toString(),'PGDMP');
if(db==='billing_next')assert.ok(Date.now()-fs.statSync(backup).mtimeMs<30*60*1000,'Fresh backup required');
const marker=path.join(path.dirname(backup),'operational-reset-'+db+'.json');
assert.ok(!fs.existsSync(marker),'This one-time reset has already completed');
const run=args=>execFileSync(docker,args,{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
const running=run(['ps','-q']).split(/\s+/).filter(Boolean);
for(const id of running){const c=JSON.parse(run(['inspect',id]))[0];assert.ok(!(c.Config.Env||[]).includes('DB_NAME='+db),'Stop backend connected to '+db);}
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
assert.equal(sql('select current_database()'),db);
assert.ok(['51','53'].includes(sql('select max(version::int) from flyway_schema_history where success')));
const cleared=['billing_charge','comprehensive_service_order','comprehensive_service_order_tariff','container_owner','container_owner_history','container_storage_period','payment_invoice','payment_invoice_line','receiving_order','receiving_order_container','receiving_order_container_item','route','service_execution','service_order','service_order_container','shipping_order','shipping_order_container','shipping_order_container_item','shipping_order_railway_carriage','shipping_order_source_container','waybill','waybill_container','waybill_container_relocation','waybill_product','waybill_railway_carriage','waybill_zpu'].sort();
const preserved=['application_clock','client','client_driver','client_related_entity','client_vehicle','complex_service_catalog','complex_service_tariff','container','contract','danger_class','danger_product','etsng_code','flyway_schema_history','payer','railway_carriage','railway_carriage_model','railway_carriage_type','railway_station','seal_type','terminal_area_catalog'].sort();
const all=sql("select tablename from pg_tables where schemaname='public' order by tablename").split('\n');
assert.deepEqual(all,[...cleared,...preserved].sort(),'Schema changed: review reset scope');
const list=cleared.map(t=>"'public."+t+"'::regclass").join(',');
assert.equal(sql(`select count(*) from pg_constraint where contype='f' and confrelid in (${list}) and conrelid not in (${list})`),'0','Unexpected incoming foreign key');
const hash=t=>`select count(*)||':'||md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) order by to_jsonb(t)::text),'')) from "${t}" t`;
const sequences=sql("select sequencename from pg_sequences where schemaname='public' order by sequencename").split('\n').filter(Boolean);
assert.ok(sequences.every(t=>/^[a-z_]+$/.test(t)));
const before=Object.fromEntries(all.map(t=>[t,sql(hash(t))]));
const seq=Object.fromEntries(sequences.map(t=>[t,sql(`select last_value||':'||is_called from "${t}"`)]));
const assertions=Object.entries(before).map(([t,h])=>`IF (${hash(t)})<>'${h}' THEN RAISE EXCEPTION 'Concurrent change: ${t}'; END IF;`).join('\n');
const verify=preserved.map(t=>`IF (${hash(t)})<>'${before[t]}' THEN RAISE EXCEPTION 'Preserved table changed: ${t}'; END IF;`).join('\n')+sequences.map(t=>`IF (select last_value||':'||is_called from "${t}")<>'${seq[t]}' THEN RAISE EXCEPTION 'Sequence changed: ${t}'; END IF;`).join('\n');
sql(`BEGIN; SET LOCAL lock_timeout='10s'; LOCK TABLE ${all.map(t=>'"'+t+'"').join(',')} IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN ${assertions} END $$;
TRUNCATE TABLE ${cleared.join(',')} CONTINUE IDENTITY RESTRICT;
DO $$ BEGIN ${verify}
${cleared.map(t=>`IF EXISTS(SELECT 1 FROM ${t}) THEN RAISE EXCEPTION 'Not empty: ${t}'; END IF;`).join('\n')}
END $$;
${mode==='--dry-run'?'ROLLBACK':'COMMIT'};`);
for(const t of mode==='--dry-run'?all:preserved)assert.equal(sql(hash(t)),before[t],t);
if(mode==='--clear-all-operational-data'){
 for(const t of cleared)assert.equal(sql('select count(*) from '+t),'0',t);
 fs.writeFileSync(marker,JSON.stringify({db,backup,backupSha256:crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex'),before,sequences:seq,cleared,preserved,completedAt:new Date().toISOString()},null,2),{flag:'wx'});
}
console.log('PASS '+mode+': '+cleared.length+' operational tables; '+preserved.length+' preserved tables and all sequences unchanged');
