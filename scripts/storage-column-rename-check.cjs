// Compare a restored V35 database with V36; never connects to the working database.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const db='billing_storage_rename_test',docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).trim();
assert.equal(sql('select current_database()'),db);
const names={arrival_history_id:'receiving_history_id',departure_history_id:'shipping_history_id',arrival_at:'receiving_at',departure_at:'shipping_at',arrival_owner_id:'receiving_owner_id',storage_period_arrival_idx:'storage_period_receiving_idx'};
const normalize=s=>Object.entries(names).reduce((v,[a,b])=>v.replaceAll(a,b),s);
const version=Number(sql('select max(version::int) from flyway_schema_history where success'));
const snapshot=path.resolve(__dirname,'../backups/storage-rename-before.json');
function state(){
 const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'flyway_schema_history'"));
 const rows={};for(const table of tables){let expression='to_jsonb(t)';if(table==='container_storage_period'&&version===35){for(const [a,b]of Object.entries(names).slice(0,5))expression=`((${expression})-'${a}')||jsonb_build_object('${b}',t.${a})`;}
  rows[table]=sql(`select count(*)||':'||md5(coalesce(string_agg((${expression})::text,chr(10) order by (${expression})::text),'')) from public."${table}" t`);
 }
 const constraints=normalize(sql("select json_agg(r order by oid) from (select oid,conname,contype,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='container_storage_period'::regclass)r"));
 const indexes=normalize(sql("select json_agg(r order by indexrelid) from (select indexrelid,pg_get_indexdef(indexrelid) as definition,indisvalid from pg_index where indrelid='container_storage_period'::regclass)r"));
 return {rows,constraints,indexes};
}
if(process.argv[2]==='capture'){
 assert.equal(version,35);assert.ok(!fs.existsSync(snapshot),'Snapshot already exists');fs.writeFileSync(snapshot,JSON.stringify(state()));console.log('Captured V35 rows and constraints');
}else{
 assert.equal(version,36);assert.deepEqual(state(),JSON.parse(fs.readFileSync(snapshot,'utf8')));
 const columns=JSON.parse(sql("select json_agg(column_name) from information_schema.columns where table_schema='public' and table_name='container_storage_period'"));
 for(const [a,b]of Object.entries(names).slice(0,5)){assert.ok(!columns.includes(a));assert.ok(columns.includes(b));}
 console.log('PASS: V36 preserves all business rows, keys, checks and indexes; five columns renamed');
}
