// Fault injection is transaction-local and always rolled back. Requires a separate restored V47 DB.
const fs=require('fs'),assert=require('node:assert/strict'),{execFileSync}=require('child_process');
const db='billing_storage_arrival_migration_test',docker=process.env.DOCKER_EXE||'docker';
const sql=q=>execFileSync(docker,['exec','-i','billing-next-db-1','psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:64*1024*1024}).trim();
assert.equal(sql('select current_database()'),db);
assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'47');
assert.ok(Number(sql("select count(*) from container_owner_history where operation_type='ARRIVAL'"))>1);
const before=sql("select md5(string_agg(to_jsonb(p)::text,chr(10) order by id)) from container_storage_period p");
const migration=fs.readFileSync('backend/src/main/resources/db/baseline/V48__storage_arrival_and_boundaries.sql','utf8');
for(const [body,pattern] of [
 ["SELECT id INTO NEW.arrival_history_id FROM container_owner_history WHERE operation_type='ARRIVAL' AND id<>NEW.receiving_history_id ORDER BY id LIMIT 1;",/Invalid storage origin:/],
 ["NEW.updated_at:=NEW.updated_at+interval '1 day';",/Storage report changed during V48/]
]){
 let failed=false;
 try{sql("BEGIN; CREATE FUNCTION v48_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "+body+" RETURN NEW; END $$; CREATE TRIGGER v48_fault BEFORE UPDATE ON container_storage_period FOR EACH ROW EXECUTE FUNCTION v48_fault();\n"+migration+"\nSET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;");}
 catch(e){failed=true;assert.match(String(e.stderr),pattern);}
 assert.ok(failed,'Migration did not reject injected corruption');
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='container_storage_period'"),'7');
 assert.equal(sql("select md5(string_agg(to_jsonb(p)::text,chr(10) order by id)) from container_storage_period p"),before);
 assert.equal(sql("select count(*) from pg_proc where proname in ('v48_fault','storage_arrival_history','protect_storage_arrival')"),'0');
}
console.log('PASS: wrong arrival and changed report abort V48 atomically; original seven columns and period data retained');
