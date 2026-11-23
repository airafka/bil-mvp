// Destructive regression: hard restricted to the isolated reset test environment.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const docker = process.env.DOCKER_EXE || 'docker';
const pg = 'billing-reset-ui-db', backend = 'billing-reset-ui-backend', db = 'billing_reset_ui_test';
const base = 'http://127.0.0.1:8325/api', endpoint = '/system/operational-reset';
const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', windowsHide: true, maxBuffer: 80 * 1024 * 1024 }).trim();
const sql = (query, database = db) => run(['exec', '-i', pg, 'psql', '-X', '-U', 'billing', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], query);
const json = (query, database) => JSON.parse(sql(query, database));
const cleared = ['billing_charge','comprehensive_service_order','comprehensive_service_order_tariff','container_owner','container_owner_history','container_period','container_visit','railway_carriage_owner_history','inbound_event','shipping_order_container_qty','shipping_order_railway_carriage_qty','shipping_order_etsng_code','payment_invoice','payment_invoice_line','receiving_order','receiving_order_container','receiving_order_container_item','route','service_execution','service_order','service_order_container','shipping_order','shipping_order_container','shipping_order_container_item','shipping_order_railway_carriage','shipping_order_source_container','waybill','waybill_container','waybill_container_relocation','waybill_product','waybill_railway_carriage','waybill_zpu'];
const tables = () => sql("select tablename from pg_tables where schemaname='public' order by tablename").split('\n');
function snapshot(database = db) {
  return json("select json_object_agg(name, fingerprint) from (" + tables().map(t => `select '${t}' name, count(*)||':'||md5(coalesce(string_agg(to_jsonb(t)::text, chr(10) order by to_jsonb(t)::text),'')) fingerprint from public.${t} t`).join(' union all ') + ') s', database);
}
function sequences() { return Object.fromEntries(sql("select sequencename from pg_sequences where schemaname='public' order by sequencename").split('\n').map(name => [name, sql('select last_value||\':\'||is_called from public.' + name)])); }
async function api(path, method = 'GET', body, expected = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); assert.equal(res.status, expected, path + ': ' + text); return text ? JSON.parse(text) : null;
}
async function main() {
  const info = JSON.parse(run(['inspect', backend]))[0], pgInfo = JSON.parse(run(['inspect', pg]))[0];
  assert.equal(info.Config.Labels['billing.task'], 'operational-reset-ui');
  assert.equal(pgInfo.Config.Labels['billing.task'], 'operational-reset-ui');
  assert.ok(info.Config.Env.includes('DB_NAME=' + db)); assert.ok(info.Config.Env.includes('DB_HOST=db'));
  assert.ok(info.NetworkSettings.Ports['8080/tcp'].some(p => p.HostPort === '8325'));
  assert.deepEqual(Object.keys(info.NetworkSettings.Networks), ['billing-reset-ui-test']);
  assert.equal(sql('select current_database()'), db);
  assert.equal(sql('select max(version::int) from flyway_schema_history where success'), '59');
  const before = snapshot(), numbers = sequences(), preview = await api(endpoint);
  assert.ok(preview.totalRows > 0, 'Restore populated source first');
  await api(endpoint, 'POST', { confirmation: 'delete', token: preview.token }, 400);
  await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: 'outdated' }, 409);
  sql('begin; update receiving_order set comment=coalesce(comment,\'\')||\' changed\' where id=(select id from receiving_order limit 1); commit;');
  await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: preview.token }, 409);
  // Restore exactly the original comment, including NULL, from the source dump's copy below instead of guessing.
  assert.equal(sql("select count(*) from pg_stat_activity where datname='billing_reset_ui_original'"), '0');
  sql('drop database if exists billing_reset_ui_original');
  sql('create database billing_reset_ui_original');
  run(['exec', pg, 'pg_restore', '-U', 'billing', '-d', 'billing_reset_ui_original', '--no-owner', '--single-transaction', '--exit-on-error', '/tmp/source.dump']);
  const comments = json('select json_agg(json_build_object(\'id\',id,\'comment\',comment)) from receiving_order', 'billing_reset_ui_original');
  for (const row of comments) sql(`update receiving_order set comment=${row.comment === null ? 'NULL' : "'" + row.comment.replaceAll("'", "''") + "'"} where id='${row.id}'`);
  assert.deepEqual(snapshot(), before);
  run(['exec', '-u', 'root', backend, 'chmod', '500', '/app/reset-backups']);
  try { await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: preview.token }, 503); }
  finally { run(['exec', '-u', 'root', backend, 'chmod', '700', '/app/reset-backups']); }
  assert.deepEqual(snapshot(), before, 'Backup failure changed data');
  // An unexpected FK outside public must roll back the entire operation (no CASCADE).
  sql('create schema reset_guard; create table reset_guard.reference (order_id uuid references public.receiving_order(id));');
  try { await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: preview.token }, 409); }
  finally { sql('drop table reset_guard.reference; drop schema reset_guard;'); }
  assert.deepEqual(snapshot(), before, 'Dependency failure changed data');
  const holder = spawn(docker, ['exec','-i',pg,'psql','-X','-U','billing','-d',db,'-At','-v','ON_ERROR_STOP=1'], { windowsHide: true });
  const held = new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  holder.stdin.end('begin; select pg_advisory_xact_lock(729458201); select pg_sleep(3); commit;');
  await held;
  await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: preview.token }, 409);
  await new Promise((resolve, reject) => { holder.once('exit', code => code === 0 ? resolve() : reject(Error('Lock holder failed'))); });
  const clearedResult = await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: preview.token });
  assert.ok(clearedResult.cleared); assert.match(clearedResult.backupFile, /^before-reset-.*\.dump$/);
  const after = snapshot();
  for (const table of tables()) if (cleared.includes(table)) assert.ok(after[table].startsWith('0:'), table); else assert.equal(after[table], before[table], table);
  assert.deepEqual(sequences(), numbers, 'Sequences changed');
  const bytes = execFileSync(docker, ['exec', backend, 'cat', '/app/reset-backups/' + clearedResult.backupFile], { windowsHide: true, maxBuffer: 80 * 1024 * 1024 });
  assert.equal(bytes.subarray(0,5).toString(), 'PGDMP');
  sql('create database billing_reset_ui_restore');
  run(['exec','-i',pg,'pg_restore','-U','billing','-d','billing_reset_ui_restore','--no-owner','--single-transaction','--exit-on-error'], bytes);
  assert.deepEqual(snapshot('billing_reset_ui_restore'), before, 'Automatic backup restore mismatch');
  assert.deepEqual((await api('/container-storage-periods')).items, []);
  const csv = await (await fetch(base + '/container-storage-periods/export')).text();
  assert.equal(csv.trim().split(/\r?\n/).length, 1); assert.equal(csv.trim().split(';').length, 17);
  await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: preview.token }, 409);
  const empty = await api(endpoint); assert.equal(empty.totalRows, 0);
  assert.deepEqual(await api(endpoint, 'POST', { confirmation: 'УДАЛИТЬ', token: empty.token }), { cleared: false });
  console.log('PASS: confirmation, changed data, backup failure, FK rollback, concurrent reset, preserved catalogs/sequences, automatic backup restore, empty report/17-column CSV, repeat reset');

  const tariff = json('select row_to_json(t) from (select client_id,contract_id from complex_service_tariff where active order by id limit 1)t');
  const clients = await api('/references/clients'), owner = tariff.client_id, other = clients.find(c => c.id !== owner).id, party = clients.find(c => c.id === owner).name;
  const area = (await api('/references/terminal-areas')).find(a => a.code === 'CONTAINER').id;
  const catalogs = await Promise.all(['carriers','drivers','vehicles'].map(k => api('/transport-catalogs/' + k + '?activeOnly=true')));
  const logistics = { carrierId: catalogs[0][0].id, driverId: catalogs[1][0].id, vehicleId: catalogs[2][0].id };
  const waybill = await api('/waybills/generate', 'POST', { standard20: 0, standard40: 1 }, 201);
  const container = sql(`select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id where wr.waybill_id='${waybill.id}' limit 1`);
  const date = (await api('/application-clock')).date;
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  async function create(kind) { return api('/'+kind+'-orders','POST',{clientId:owner,contractId:tariff.contract_id,terminalAreaId:area,transportType:'VEHICLE',fillingType:'ALL',...(kind==='receiving'?{defaultContainerOwnerId:owner}:{}),arrivalAt:date+'T12:00:00',departureAt:date+'T12:00:00',consignor:party,consignee:party,containers:[{containerId:container,empty:true,ownerClientId:kind==='receiving'?owner:other}]},201); }
  async function finish(kind,id) {const route=await api('/routes','POST',{routeType:kind==='receiving'?'RECEIVING':'SHIPPING',transportType:'VEHICLE',terminalAreaId:area,departureAt:date+'T12:00:00+03:00',...logistics,orderIds:[id]},201);await api('/routes/'+route.route.id+'/confirm','POST',{});await api('/'+kind+'-orders/'+id+'/events','POST',{eventCode:kind==='receiving'?'UNLOAD_FINISH':'LOAD_FINISH'});}
  const receipt = await create('receiving'); await finish('receiving', receipt.id);
  const stock = sql(`select id from container_owner where container_id='${container}'`);
  const transfer = await api('/service-orders','POST',{clientId:other,service:'CHANGE_OWNER',containerOwnerIds:[stock],effectiveDate:date},201);
  await api('/service-orders/'+transfer.order.id+'/accept','POST');
  assert.equal(sql(`select client_id from container_owner_current where container_id='${container}'`),other);
  const shipment = await create('shipping'); await finish('shipping', shipment.id);
  await api('/shipping-orders/'+shipment.id+'/cancellation','POST',{expectedStatus:'COMPLETED'});
  assert.equal(sql(`select status from container_owner where container_id='${container}'`),'ON_TERMINAL');
  await api('/receiving-orders/'+receipt.id+'/cancellation','POST',{expectedStatus:'COMPLETED'});
  assert.deepEqual((await api('/container-storage-periods')).items,[]);
  const repeat = await create('receiving'); await finish('receiving',repeat.id);
  assert.equal(sql(`select count(*) from container_visit where container_id='${container}'`),'2');
  const future = new Date(date+'T00:00:00Z'); future.setUTCDate(future.getUTCDate()+2);
  const deferred = await api('/service-orders','POST',{clientId:other,service:'CHANGE_OWNER',containerOwnerIds:[stock],effectiveDate:future.toISOString().slice(0,10)},201);
  await api('/service-orders/'+deferred.order.id+'/accept','POST');
  assert.equal(sql(`select client_id from container_owner_current where container_id='${container}'`),owner);
  console.log('PASS: new receiving, ownership transfer, shipping, both cancellations, repeated receiving, future transfer after reset; populated fixtures left for UI check');
}
main().catch(error => { console.error(error); process.exitCode=1; });
