const {run,sql,fs}=require('./ops.cjs'),assert=require('node:assert/strict');
const path=require('node:path');
const pg='billing-visit-check-db',db='billing_visit_rejection';
assert.equal(JSON.parse(run(['inspect',pg]))[0].Config.Labels['billing.task'],'visit-check');
run(['exec',pg,'createdb','-U','billing',db]);
try{
 run(['exec',pg,'pg_restore','-U','billing','-d',db,'--no-owner','--no-privileges','--exit-on-error','/tmp/seeded.dump']);
 sql(pg,db,"update container_owner o set client_id=(select id from client where id<>o.client_id order by id limit 1) where id=(select id from container_owner limit 1)");
 let failed=false;try{sql(pg,db,'BEGIN;'+fs.readFileSync(path.join(__dirname,'../../backend/src/main/resources/db/baseline/V55__container_visits_and_ownership.sql'),'utf8')+'COMMIT;');}catch(e){assert.match(e.stderr,/Ownership migration does not match/);failed=true;}
 assert.ok(failed);assert.equal(sql(pg,db,"select relkind from pg_class where oid='container_storage_period'::regclass"),'r');assert.equal(sql(pg,db,"select to_regclass('container_visit') is null"),'t');assert.equal(sql(pg,db,'select max(version::int) from flyway_schema_history'),'54');
 console.log('PASS ambiguous ownership rejects migration atomically; old physical schema and Flyway V54 remain');
}finally{run(['exec',pg,'dropdb','-U','billing',db]);}
