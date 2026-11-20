// Run only after migrating the disposable V59 copy to V60, before restricted-writer checks.
const assert=require('node:assert/strict');const {run,sql:query}=require('../storage-visits/ops.cjs');
const pg='billing-stock-write-db',db='billing_stock_write_test',network='billing-stock-write-check';
const sql=q=>query(pg,db,q),database=JSON.parse(run(['inspect',pg]))[0],backend=JSON.parse(run(['inspect','billing-stock-write-new']))[0];
assert.equal(database.Config.Labels['billing.task'],'stock-write-v60');assert.ok(database.Mounts.every(m=>m.Type==='tmpfs'));assert.deepEqual(Object.keys(database.NetworkSettings.Networks),[network]);
assert.ok(backend.Config.Env.includes('DB_NAME='+db));assert.ok(backend.Config.Env.includes('DB_HOST='+pg));assert.equal(backend.Config.Labels['billing.task'],'stock-write-v60');assert.ok(backend.NetworkSettings.Ports['8080/tcp'].some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='8306'));
assert.equal(sql('select current_database()'),db);assert.equal(sql('select max(version::int) from flyway_schema_history where success'),'60');
sql(`CREATE ROLE stock_operation_writer LOGIN PASSWORD 'isolated-stock-only';
 GRANT USAGE ON SCHEMA public TO stock_operation_writer;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO stock_operation_writer;
 DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'container_owner_history' LOOP
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO stock_operation_writer',r.tablename);END LOOP;
 FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
 EXECUTE format('ALTER VIEW public.%I SET (security_invoker=true)',r.viewname);
 EXECUTE format('GRANT SELECT ON public.%I TO stock_operation_writer',r.viewname);END LOOP;
 END $$;
 GRANT INSERT ON container_owner_history TO stock_operation_writer;`);
assert.equal(sql("select has_table_privilege('stock_operation_writer','container_owner_history','SELECT')"),'f');
assert.equal(sql("select has_table_privilege('stock_operation_writer','container_owner_history','UPDATE')"),'f');
console.log('PASS test writer can append journal records, but cannot read or update them; views cannot bypass permissions');
