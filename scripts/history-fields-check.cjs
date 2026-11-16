// V38 -> V39 preservation check; writes only to the explicitly named isolated database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const docker=process.env.DOCKER_EXE||'docker',db='billing_history_fields_test';
const args=['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'];
const sql=q=>execFileSync(docker,args,{input:q,encoding:'utf8',windowsHide:true}).trim();
assert.equal(sql('select current_database()'),db);
const snapshot=path.resolve(__dirname,'../backups/history-fields-before.json');
const removed=['target_history_id','source_system','source_operation_key','reason','needs_review','review_reason'];
function state(){const result={};for(const table of sql("select tablename from pg_tables where schemaname='public' and tablename<>'flyway_schema_history' order by tablename").split('\n')){
 const expr=table==='container_owner_history'?"to_jsonb(t)"+removed.map(n=>"-'"+n+"'").join(''):'to_jsonb(t)';
 result[table]=JSON.parse(sql(`select json_build_object('count',count(*),'hash',md5(coalesce(string_agg((${expr})::text,E'\\n' order by (${expr})::text),''))) from "${table}" t`));
 }result.sequences=JSON.parse(sql("select coalesce(json_agg(s order by sequencename),'[]') from (select sequencename,last_value from pg_sequences where schemaname='public')s"));return result;}
const version=Number(sql('select max(version::int) from flyway_schema_history where success'));
if(process.argv.includes('capture')){
 assert.equal(version,38);assert.ok(!fs.existsSync(snapshot),'Snapshot already exists');
 const before=state();assert.ok(before.container_owner_history.count>0);
 const migration=fs.readFileSync(path.resolve(__dirname,'../backend/src/main/resources/db/baseline/V39__simplify_container_owner_history.sql'),'utf8');
 const rejected=spawnSync(docker,args,{input:"BEGIN; UPDATE container_owner_history SET needs_review=true WHERE id=(SELECT id FROM container_owner_history LIMIT 1);\n"+migration+'\nCOMMIT;',encoding:'utf8',windowsHide:true});
 assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/history requires review/);
 assert.equal(sql('select count(*) from container_owner_history where needs_review'),'0');
 assert.deepEqual(state(),before);fs.mkdirSync(path.dirname(snapshot),{recursive:true});fs.writeFileSync(snapshot,JSON.stringify(before));
 console.log('PASS: unresolved history rejects V39 atomically; V38 business data and sequences captured');
}else{
 assert.equal(version,39);assert.deepEqual(state(),JSON.parse(fs.readFileSync(snapshot,'utf8')));
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_owner_history' and column_name in ("+removed.map(n=>"'"+n+"'").join(',')+")"),'0');
 assert.equal(sql("select count(*) from pg_indexes where schemaname='public' and indexname='history_source_operation_uq'"),'0');
 assert.equal(sql("select count(*) from pg_constraint where conrelid='container_owner_history'::regclass and conname='history_storage_period_fk'"),'1');
 console.log('PASS: V39 removes only six history fields; all remaining business values, cancellation reasons, storage links and sequences preserved');
}
