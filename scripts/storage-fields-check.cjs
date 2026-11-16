// V37 -> V38 preservation check. Writes only to the named isolated test database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_storage_fields_test';
const args=['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'];
const sql=q=>execFileSync(docker,args,{input:q,encoding:'utf8',windowsHide:true}).trim();
assert.equal(sql('select current_database()'),db);
const snapshot=path.resolve(__dirname,'../backups/storage-fields-before.json');
function state(){const result={};for(const table of sql("select tablename from pg_tables where schemaname='public' and tablename<>'flyway_schema_history' order by tablename").split('\n')){
 const expr=table==='container_storage_period'?"to_jsonb(t)-'needs_review'-'review_reason'-'version'":'to_jsonb(t)';
 result[table]=JSON.parse(sql(`select json_build_object('count',count(*),'hash',md5(coalesce(string_agg((${expr})::text,E'\\n' order by (${expr})::text),''))) from "${table}" t`));
 }return result;}
const version=Number(sql('select max(version::int) from flyway_schema_history where success'));
if(process.argv.includes('capture')){
 assert.equal(version,37);assert.ok(!fs.existsSync(snapshot),'Snapshot already exists');
 const before=state();assert.ok(before.container_storage_period.count>0);
 const migration=fs.readFileSync(path.resolve(__dirname,'../backend/src/main/resources/db/baseline/V38__remove_storage_review_and_version.sql'),'utf8');
 const rejected=spawnSync(docker,args,{input:"BEGIN; UPDATE container_storage_period SET needs_review=true WHERE id=(SELECT id FROM container_storage_period LIMIT 1);\n"+migration+'\nCOMMIT;',encoding:'utf8',windowsHide:true});
 assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/require review/);
 assert.equal(sql('select count(*) from container_storage_period where needs_review'),'0');
 assert.deepEqual(state(),before);fs.mkdirSync(path.dirname(snapshot),{recursive:true});fs.writeFileSync(snapshot,JSON.stringify(before));
 console.log('PASS: unresolved legacy period rejects V38 atomically; V37 data captured');
}else{
 assert.equal(version,38);assert.deepEqual(state(),JSON.parse(fs.readFileSync(snapshot,'utf8')));
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period' and column_name in ('needs_review','review_reason','version')"),'0');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history' and column_name in ('needs_review','review_reason')"),'2');
 const index=sql("select indexdef from pg_indexes where schemaname='public' and indexname='storage_one_open_uq'");
 assert.match(index,/UNIQUE/);assert.match(index,/OPEN/);assert.ok(!index.includes('needs_review'));
 assert.equal(sql("select count(*) from pg_constraint where conrelid='container_storage_period'::regclass and conname in ('storage_receiving_source_check','storage_shipping_source_check')"),'2');
 for(const [update,constraint] of [
  ["UPDATE container_storage_period SET receiving_order_container_id=NULL,waybill_container_id=NULL WHERE id=(SELECT id FROM container_storage_period LIMIT 1)",'storage_receiving_source_check'],
  ["UPDATE container_storage_period SET shipping_order_container_id=NULL WHERE id=(SELECT id FROM container_storage_period WHERE status='CLOSED' LIMIT 1)",'storage_shipping_source_check']]){
  const rejected=spawnSync(docker,args,{input:'BEGIN; '+update+'; ROLLBACK;',encoding:'utf8',windowsHide:true});
  assert.notEqual(rejected.status,0);assert.ok(rejected.stderr.includes(constraint),rejected.stderr);
 }
 assert.deepEqual(state(),JSON.parse(fs.readFileSync(snapshot,'utf8')));
 console.log('PASS: V38 removes only three fields, preserves all business rows and task links, history flags and storage constraints');
}
