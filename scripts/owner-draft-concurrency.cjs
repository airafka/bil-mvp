'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {init, api, sql} = require('./owner-register-check.cjs');

const backend = 'billing-register-owner-new';
const gateKey = 112061;
async function until(predicate, message) {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await delay(80);
    }
}

// Keep a transaction open in its own connection until the API reaches its lock.
async function withGate(command, work) {
    const psql = spawn(process.env.DOCKER_EXE || 'docker', [
        'exec', '-i', 'billing-register-owner-db', 'psql', '-X', '-qAt',
        '-U', 'billing', '-d', 'billing_register_owner_test', '-v', 'ON_ERROR_STOP=1'
    ], {windowsHide:true});
    let output = '';
    psql.stdout.on('data', data => { output += data; });
    psql.stderr.on('data', data => { output += data; });
    const finished = new Promise((resolve,reject) => {
        psql.once('error', reject);
        psql.once('close', resolve);
    });
    const release = () => {
        if (!psql.stdin.writableEnded) psql.stdin.end('rollback;\n\\q\n');
        return finished;
    };
    try {
        psql.stdin.write("set application_name='owner_regression_gate'; begin; " + command + ";\n\\echo READY\n");
        await until(() => output.includes('READY'), 'Test lock failed: ' + output);
        await work(release);
    } finally { await release(); }
}
const blockedBy = name => sql(`select exists(select 1 from pg_stat_activity blocker
    join pg_stat_activity waiting on blocker.pid=any(pg_blocking_pids(waiting.pid))
    where blocker.application_name='${name}' and waiting.datname=current_database())`) === 't';

async function main() {
    const x = await init(backend); // validates network, DB, backend and published port
    const day = (await api('/application-clock')).date;
    const one = await x.arrival();
    const ownerId = k => sql(`select id from container_owner where container_id='${k}'`);
    const prepare = async containers => (await api('/service-orders','POST',{
        clientId:x.b, service:'CHANGE_OWNER', effectiveDate:day, containerOwnerIds:containers.map(ownerId)
    },201)).order.id;
    const apply = id => api('/service-orders/'+id+'/accept','POST');
    const transfer = await prepare([one.ktk]);
    sql(`create function owner_regression_pause() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(${gateKey}); return new; end $$;
        create trigger owner_regression_pause before insert on shipping_order_container
        for each row when (new.container_id='${one.ktk}') execute function owner_regression_pause()`);
    try {
        let draft;
        await withGate(`select pg_advisory_xact_lock(${gateKey})`, async release => {
            const creating = x.transport('shipping',one.ktk);
            let accepting;
            try {
                await until(() => blockedBy('owner_regression_gate'), 'Draft did not reach INSERT');
                accepting = apply(transfer);
                await until(() => sql(`select exists(select 1 from pg_stat_activity inserting
                    join pg_stat_activity changing on inserting.pid=any(pg_blocking_pids(changing.pid))
                    where inserting.wait_event='advisory' and changing.datname=current_database())`) === 't',
                    'Transfer did not wait for draft owner read/write');
            } finally {
                await release();
                const results = await Promise.all([creating,accepting]);
                draft = results[0];
            }
        });
        const stored = () => sql(`select owner_container_id from shipping_order_container where shipping_order_id='${draft.id}'`);
        assert.equal(stored(),x.b);
        assert.equal((await api('/shipping-orders/'+draft.id)).containers[0].ownerClientId,x.b);
        await x.confirm('shipping',draft.id);
        assert.equal(stored(),x.b);
    } finally {
        sql('drop trigger owner_regression_pause on shipping_order_container; drop function owner_regression_pause()');
    }
    console.log('PASS concurrent transfer and draft creation preserve physical, API and confirmed owner');

    // Select unused physical containers from opposite halves of the UUID range.
    const pair = JSON.parse(sql(`select json_agg(k order by k) from (
        select distinct on (left(c.id::text,1)>='8') c.id k from container c
        where not exists(select 1 from container_owner o where o.container_id=c.id)
        order by (left(c.id::text,1)>='8'), c.id) halves`));
    assert.equal(pair.length,2,'Need one unused container on each side of the UUID sign bit');
    const [low,high] = pair;
    await x.arrival(low); await x.arrival(high);
    const both = await prepare([high,low]);
    await withGate(`select id from container where id='${low}' for update`, async release => {
        const accepting = apply(both);
        try {
            await until(() => blockedBy('owner_regression_gate'), 'Transfer did not wait for the low UUID');
            // This fails with 55P03 if the API acquired the high UUID first.
            assert.equal(sql(`select id from container where id='${high}' for update nowait`),high);
        } finally { await release(); await accepting; }
    });
    assert.equal(sql(`select count(*) from container_owner where container_id in ('${low}','${high}') and client_id='${x.b}'`),'2');
    console.log('PASS multi-container operation locks UUIDs in PostgreSQL order');
}
main().catch(error => { console.error(error); process.exitCode=1; });
