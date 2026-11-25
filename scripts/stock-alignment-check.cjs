// node scripts/stock-alignment-check.cjs <test-backend-container>
// Mutates a disposable, seeded test database. No third-party Node dependencies.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

function dockerExecutable() {
    if (process.env.DOCKER_CLI) return process.env.DOCKER_CLI;
    if (process.platform === 'win32') {
        const candidates = [
            process.env.ProgramFiles && join(process.env.ProgramFiles, 'Docker/Docker/resources/bin/docker.exe'),
            process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe'),
        ];
        const installed = candidates.find(path => path && existsSync(path));
        if (installed) return installed;
    }
    return 'docker';
}
const executable = dockerExecutable();
const docker = (...args) => execFileSync(executable, args, { encoding: 'utf8' }).trim();

async function testBackend(name) {
    assert.match(name || '', /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'Pass the name of the test backend container');
    const labels = JSON.parse(docker('inspect', '-f', '{{json .Config.Labels}}', name));
    assert.equal(labels['com.docker.compose.project'], 'billing-mvp');
    assert.equal(labels['com.docker.compose.service'], 'backend');
    const database = docker('exec', name, 'printenv', 'DB_NAME');
    assert.match(database, /^billing_mvp_[a-z0-9_]+_test_[a-z0-9_]+$/);
    const binding = docker('port', name, '8080/tcp').match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(binding && binding[1] !== '8101', 'The HTTP port must belong to a loopback-only test backend');
    const base = 'http://127.0.0.1:' + binding[1];
    const health = await fetch(base + '/actuator/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'UP');

    // Verify the actual JDBC pool before sending any mutating HTTP requests.
    const dbContainer = docker('ps', '-q', '--filter', 'label=com.docker.compose.project=billing-mvp',
        '--filter', 'label=com.docker.compose.service=db');
    assert.match(dbContainer, /^[a-f0-9]+$/, 'Expected exactly one running Compose db service');
    const backendIP = docker('inspect', '-f', '{{(index .NetworkSettings.Networks "billing-mvp_default").IPAddress}}', name);
    assert.match(backendIP, /^\d+\.\d+\.\d+\.\d+$/);
    const dbUser = docker('exec', name, 'printenv', 'DB_USER');
    const databases = docker('exec', dbContainer, 'psql', '-XAt', '-U', dbUser, '-d', 'postgres', '-c',
        "select distinct datname from pg_stat_activity where client_addr = inet('" + backendIP + "') order by datname");
    assert.equal(databases, database, 'The test backend must connect only to its test database');
    console.log('Checking ' + database + ' through ' + base);
    return base;
}

async function run(name) {
    const base = await testBackend(name);
    async function api(path, method = 'GET', body, status = 200) {
        const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        assert.equal(response.status, status, method + ' ' + path + ': ' + text);
        return text ? JSON.parse(text) : null;
    }
    const catalogs = await Promise.all(['carriers', 'drivers', 'vehicles'].map(kind => api('/transport-catalogs/' + kind + '?activeOnly=true')));
    const contract = (await api('/references/contracts'))[0];
    const clients = await api('/references/clients');
    const area = (await api('/references/terminal-areas')).find(row => row.code === 'CONTAINER');
    assert.ok(contract && area && catalogs.every(rows => rows.length), 'Seed a contract, container area and vehicle logistics');
    const source = clients.find(row => row.id === contract.clientId);
    const target = clients.find(row => row.id !== contract.clientId);
    assert.ok(source && target, 'Expected the contract client and another client');
    const baseDate = (await api('/application-clock')).date;
    function day(offset) {
        const date = new Date(baseDate + 'T00:00:00Z');
        date.setUTCDate(date.getUTCDate() + offset);
        return date.toISOString().slice(0, 10);
    }
    async function setDay(offset) {
        const clock = await api('/application-clock');
        await api('/application-clock', 'PUT', { date: day(offset), version: clock.version });
    }
    const common = { clientId: source.id, contractId: contract.id, terminalAreaId: area.id };
    async function order(kind, offset, composition) {
        return api('/' + kind + '-orders', 'POST', { ...common, transportType: 'VEHICLE',
            ...(kind === 'receiving' ? { arrivalAt: day(offset) + 'T10:00:00', consignor: source.name, defaultContainerOwnerId: source.id }
                : { departureAt: day(offset) + 'T12:00:00', consignee: source.name, fillingType: 'ALL' }), ...composition }, 201);
    }
    async function createRoute(kind, orderIds, offset, transportType) {
        const route = await api('/routes', 'POST', { terminalAreaId: area.id, transportType, orderIds,
            routeType: kind.toUpperCase(), departureAt: day(offset) + 'T10:00:00+03:00', ...(transportType === 'VEHICLE'
                ? { carrierId: catalogs[0][0].id, driverId: catalogs[1][0].id, vehicleId: catalogs[2][0].id } : {}) }, 201);
        return '/routes/' + route.route.id;
    }
    async function confirm(kind, doc, offset, transportType, status = 200) {
        const routePath = await createRoute(kind, [doc.id], offset, transportType);
        return api(routePath + '/confirm', 'POST', {}, status);
    }
    const finish = (kind, doc, containerId) => api('/' + kind + '-orders/' + doc.id + '/events', 'POST', {
        eventCode: kind === 'receiving' ? 'UNLOAD_FINISH' : 'LOAD_FINISH', containerId });
    const cancel = (kind, doc, status = 200) => api('/' + kind + '-orders/' + doc.id + '/cancellation', 'POST',
        { expectedStatus: 'COMPLETED' }, status);
    async function stock(row) {
        const page = await api('/container-owners?query=' + encodeURIComponent(row.containerName));
        const entry = page.items.find(item => item.containerId === row.containerId);
        assert.ok(entry, 'Missing register entry for ' + row.containerName);
        return entry;
    }
    const periods = async row => (await api('/container-storage-periods?query=' + encodeURIComponent(row.containerName))).items;
    const transfer = (offset, ownerIds) => api('/service-orders', 'POST', { service: 'CHANGE_OWNER', sourceClientId: source.id,
        clientId: target.id, effectiveDate: day(offset), containerOwnerIds: ownerIds }, 201);

    async function waitForTransfer(path, ready) {
        const deadline = Date.now() + 75_000;
        do {
            const state = await api(path);
            if (ready(state)) return state;
            await new Promise(resolve => setTimeout(resolve, 1000));
        } while (Date.now() < deadline);
        assert.fail('Scheduled ownership order did not reach the expected state: ' + path);
    }

    // Draft headers and their equipment are saved independently.
    const empty = await transfer(0, []);
    assert.equal(empty.order.containerQuantity, 0);
    const emptyError = await api('/service-orders/' + empty.order.id + '/accept', 'POST', undefined, 400);
    assert.equal(emptyError.errorMessage, 'Service order must contain equipment');
    await api('/service-orders/' + empty.order.id, 'DELETE', undefined, 204);

    const bill = await api('/waybills/generate', 'POST', { standard20: 2, standard40: 0 }, 201);
    const receiving = await order('receiving', 0, { transportType: 'RAILWAY', defaultRailwayCarriageOwnerId: source.id, waybillIds: [bill.id] });
    await setDay(-1);
    await confirm('receiving', receiving, 0, 'RAILWAY');
    const { containers } = await api('/receiving-orders/' + receiving.id);
    assert.equal(containers.length, 2);
    const [first, second] = containers;
    const numbered = rows => ({ containers: rows.map(row => ({ containerId: row.containerId, empty: true })) });
    const duplicate = await order('receiving', 0, numbered(containers));
    const rejected = await confirm('receiving', duplicate, 0, 'VEHICLE', 400);
    const groupedCodes = containers.map(row => row.containerName).sort().join(', ');
    assert.equal(rejected.errorMessage, 'ContainerStatus.ReceivingAlreadyReserved: [' + receiving.code + '; ' + groupedCodes + ']');
    assert.equal((await api('/receiving-orders/' + duplicate.id)).status, 'DRAFT');
    for (const row of containers) assert.equal((await stock(row)).receivingOrderId, receiving.id);

    const railReceipt = await api('/receiving-orders/' + receiving.id);
    const wagonNumber = railReceipt.waybills[0].railwayCarriages[0].number;
    function result(row, date, time) {
        return { _order: receiving.id, _id: row.taskId, orderNumber: String(receiving.code), source: 'TOS',
            site: area.name, eventCode: 'UNLOAD_FINISH', eventName: 'Выгрузка завершена', eventDateTime: day(date) + time,
            cargoResult: [{ cargoNumber: row.containerName, cargoType: 'Контейнер 20', qty: 1, active: true,
                transportType: 'ЖД', transportNumber: wagonNumber }] };
    }
    async function send(packet, status) {
        const response = await fetch(base + '/datareon/event', { method: 'POST', headers: {
            'Content-Type': 'application/json', 'External-ID': randomUUID(), Prefer: 'return=representation' },
            body: JSON.stringify(packet) });
        assert.equal(response.status, 200);
        const receipt = await response.json();
        assert.equal(receipt.status, status, JSON.stringify(receipt));
        return receipt.details;
    }
    const unload = result(first, 0, 'T23:55:00+03:00');
    // Receive after midnight; the two storage starts still belong to different Moscow days.
    await setDay(1);
    assert.equal(await send({ ...unload, cargoResult: [] }, 'INVALID'), 'TosReceivingResultAction: Required fields are empty');
    assert.equal(await send({ ...unload, _order: randomUUID(), cargoResult: [] }, 'INVALID'), 'TosReceivingResultAction: Required fields are empty');
    assert.equal(await send({ ...unload, _order: randomUUID() }, 'FAILED'), 'Suitable order not found');
    assert.match(await send({ ...unload, _id: randomUUID() }, 'FAILED'), /ReceivingOrderContainer not found by id:/);
    assert.match(await send({ ...unload, cargoResult: result(second, 0, 'T23:55:00+03:00').cargoResult }, 'INVALID'), /TOS_TASK_CONTAINER_MISMATCH/);
    assert.equal((await stock(first)).status, 'EXPECTED');
    assert.equal((await periods(first)).length, 0);
    await send(unload, 'DONE');
    assert.equal(await send({ ...unload, cargoResult: [] }, 'INVALID'), 'TosReceivingResultAction: Required fields are empty');
    await send(unload, 'DONE');
    assert.equal((await api('/receiving-orders/' + receiving.id)).status, 'CONFIRMED');
    // Transfer one received unit while the other task is still waiting.
    const ownership = await transfer(2, [(await stock(first)).id]);
    const path = '/service-orders/' + ownership.order.id;
    await api(path + '/containers', 'PUT', []);
    assert.equal((await api(path)).order.containerQuantity, 0);
    await api(path + '/containers', 'PUT', [{ containerOwnerId: (await stock(first)).id }]);
    assert.equal((await api(path + '/accept', 'POST')).order.status, 'SCHEDULED');
    const denied = await api(path, 'DELETE', undefined, 403);
    assert.equal(denied.errorCode, 'AccessDenied');
    assert.equal((await stock(first)).clientId, source.id);
    await send(result(second, 1, 'T00:05:00+03:00'), 'DONE');
    assert.equal((await api('/receiving-orders/' + receiving.id)).status, 'COMPLETED');
    assert.equal((await api(path)).order.exportQueued, true);
    await setDay(2);
    // The backend worker runs on the minute. Reading stock does not execute the transfer.
    const executed = await waitForTransfer(path, state => state.order.status === 'DONE');
    assert.equal(executed.order.status, 'DONE', executed.order.executionError);
    assert.equal(executed.order.exportQueued, true);
    assert.equal((await stock(first)).clientId, target.id);
    assert.equal((await api(path)).order.status, 'DONE');

    // The first KTK already changed owner. A pending transfer on the second blocks the whole route.
    const ownershipHold = await transfer(6, [(await stock(second)).id]);
    const holdPath = '/service-orders/' + ownershipHold.order.id;
    assert.equal((await api(holdPath + '/accept', 'POST')).order.status, 'SCHEDULED');
    const beforeConfirmation = await Promise.all(containers.map(stock));
    const shipping = await order('shipping', 2, numbered(containers));
    const routePath = await createRoute('shipping', [shipping.id], 2, 'VEHICLE');
    async function checkRefusal(route, holdNumber, containerName) {
        const refused = await api(route + '/confirm', 'POST', {}, 409);
        assert.equal(refused.code, 'OWNERSHIP_TRANSFER_PLANNED');
        assert.equal(refused.detail, `По КТК ${containerName} ожидает выполнения заявка на смену собственника №${holdNumber}.`);
        const rejectedRoute = await api(route);
        assert.equal(rejectedRoute.route.status, 'DRAFT');
        assert.ok(rejectedRoute.orders.every(row => row.status === 'DRAFT'));
    }
    await checkRefusal(routePath, ownershipHold.order.number, second.containerName);
    const wagon = (await api('/references/railway-carriages?q=' + wagonNumber)).find(row => row.name === wagonNumber);
    assert.ok(wagon, 'Missing received wagon ' + wagonNumber);
    const railShipping = await order('shipping', 2, { transportType: 'RAILWAY',
        railwayCarriages: [{ railwayCarriageId: wagon.id, ...numbered(containers) }] });
    const railRoute = await createRoute('shipping', [railShipping.id], 2, 'RAILWAY');
    await checkRefusal(railRoute, ownershipHold.order.number, second.containerName);
    const roadOrders = await Promise.all(containers.map(row => order('shipping', 2, numbered([row]))));
    const combinedRoute = await createRoute('shipping', roadOrders.map(row => row.id), 2, 'VEHICLE');
    await checkRefusal(combinedRoute, ownershipHold.order.number, second.containerName);
    assert.deepEqual(await Promise.all(containers.map(stock)), beforeConfirmation);
    assert.equal((await api(holdPath)).order.status, 'SCHEDULED');
    assert.equal((await api(holdPath + '/cancellation', 'POST')).order.status, 'CANCELLED');
    assert.equal((await api(routePath + '/confirm', 'POST', {})).route.status, 'CONFIRMED');
    await api(holdPath + '/containers', 'PUT', [], 403);
    await api(holdPath + '/accept', 'POST', undefined, 409);
    const cancelError = await cancel('receiving', receiving, 400);
    assert.equal(cancelError.errorMessage, 'ContainerStatus.CancelReceivingInShipping: [' + shipping.code + '; ' + groupedCodes + ']');
    await setDay(3);
    assert.equal((await finish('shipping', shipping)).status, 'COMPLETED');
    const closed = await periods(first);
    assert.deepEqual(closed.map(row => [row.ownerName, row.storageDays]).sort(), [[source.name, 3], [target.name, 2]].sort());
    const onTransfer = new URLSearchParams({ query: first.containerName, storedFrom: day(2), storedTo: day(2) });
    const { items: [visit] } = await api('/container-periods/visits?' + onTransfer);
    assert.equal(visit.storageDays, 4);
    assert.equal(visit.storageDaysInPeriod, 1);
    assert.deepEqual(visit.periods.map(row => row.storageDaysInPeriod), [1, 1]);
    assert.deepEqual((await periods(second)).map(row => [row.ownerName, row.storageDays]), [[source.name, 3]]);

    await setDay(4);
    const repeat = await order('receiving', 4, numbered([first]));
    await confirm('receiving', repeat, 4, 'VEHICLE');
    const expected = await stock(first);
    assert.equal(expected.receivingOrderId, repeat.id);
    assert.equal(expected.shippingOrderId, shipping.id);
    assert.equal(expected.status, 'EXPECTED');
    const stale = await cancel('shipping', shipping, 400);
    assert.equal(stale.errorMessage, 'ContainerStatus.CancelShippingExpected: [' + repeat.code + '; ' + first.containerName + ']');
    await finish('receiving', repeat);
    const secondShipping = await order('shipping', 4, numbered([first]));
    await confirm('shipping', secondShipping, 4, 'VEHICLE');
    await finish('shipping', secondShipping);
    await cancel('shipping', secondShipping);
    const reopened = await stock(first);
    assert.equal(reopened.status, 'ON_TERMINAL');
    assert.equal(reopened.shippingOrderId, shipping.id);
    await cancel('receiving', repeat);
    const restored = await stock(first);
    assert.equal(restored.status, 'DEPARTED');
    assert.equal(restored.clientId, target.id);
    assert.equal(restored.receivingOrderId, receiving.id);
    assert.equal(restored.shippingOrderId, shipping.id);
    assert.deepEqual(await periods(first), closed);
    const roadReceipt = await order('receiving', 4, numbered([second]));
    await confirm('receiving', roadReceipt, 4, 'VEHICLE');
    await finish('receiving', roadReceipt);
    const unnumbered = await order('shipping', 4, { fillingType: 'NONE_CONTAINER',
        containerQuantities: [{ quantity: 1, type: 'STANDARD_20', empty: true, ownerClientId: source.id }] });
    // An unnumbered order has no physical KTK until LOAD_FINISH.
    const loadHold = await transfer(7, [(await stock(second)).id]);
    const loadHoldPath = '/service-orders/' + loadHold.order.id;
    await api(loadHoldPath + '/accept', 'POST');
    await confirm('shipping', unnumbered, 4, 'VEHICLE');
    const candidates = (containerType, clientId, row) => api('/container-owners?' + new URLSearchParams({
        status: 'ON_TERMINAL', containerType, clientId, query: row.containerName, size: '1',
    }));
    const eligible = await candidates('STANDARD_20', source.id, second);
    assert.equal(eligible.totalElements, 1);
    assert.equal(eligible.items[0].containerId, second.containerId);
    assert.equal((await candidates('STANDARD_40', source.id, second)).totalElements, 0);
    assert.equal((await candidates('STANDARD_20', target.id, second)).totalElements, 0);
    const cargo = { ...unload.cargoResult[0], cargoNumber: second.containerName, transportType: 'АВТО', transportNumber: 'А001АА' };
    const load = { ...unload, _order: unnumbered.id, orderNumber: String(unnumbered.code), _id: randomUUID(),
        eventCode: 'LOAD_FINISH', eventName: 'Погрузка завершена', eventDateTime: (await api('/application-clock')).now, cargoResult: [cargo] };
    assert.equal(await send({ ...load, cargoResult: [cargo, cargo] }, 'INVALID'),
        'TosShipmentResultAction: Exactly one cargoResult is required for NONE_CONTAINER shipping order');
    const unknown = 'MISSING-' + randomUUID();
    const withNumber = cargoNumber => ({ ...load, cargoResult: [{ ...cargo, cargoNumber }] });
    assert.equal(await send(withNumber(unknown), 'FAILED'), 'Container not found by code: ' + unknown);
    const unusedBill = await api('/waybills/generate', 'POST', { standard20: 1, standard40: 0 }, 201);
    const draft = await order('receiving', 4, { transportType: 'RAILWAY', defaultRailwayCarriageOwnerId: source.id, waybillIds: [unusedBill.id] });
    const unused = (await api('/receiving-orders/' + draft.id)).containers[0].containerName;
    assert.equal(await send(withNumber(unused), 'INVALID'), unused + '.TosShipmentResult.ContainerOwnerNotFound');
    assert.equal((await stock(second)).status, 'ON_TERMINAL');
    const beforeLoad = await stock(second);
    const beforeStorage = await periods(second);
    const blockedLoad = await send(load, 'INVALID');
    assert.ok(blockedLoad.includes(String(loadHold.order.number)) && blockedLoad.includes(second.containerName), blockedLoad);
    assert.equal((await api('/shipping-orders/' + unnumbered.id)).status, 'CONFIRMED');
    assert.equal((await api('/shipping-orders/' + unnumbered.id)).containers.length, 0);
    assert.deepEqual(await stock(second), beforeLoad);
    assert.deepEqual(await periods(second), beforeStorage);
    assert.equal((await api(loadHoldPath)).order.status, 'SCHEDULED');
    await api(loadHoldPath + '/cancellation', 'POST');
    await send(load, 'DONE');
    await send(load, 'DONE');
    assert.equal((await api('/shipping-orders/' + unnumbered.id)).status, 'COMPLETED');
    assert.equal((await stock(second)).shippingOrderId, unnumbered.id);
    assert.equal((await candidates('STANDARD_20', source.id, second)).totalElements, 0);
    assert.deepEqual((await periods(second)).map(row => row.storageDays).sort(), [1, 3]);
    // A scheduled document is indivisible even if one of its arrivals is later cancelled.
    async function receiveBatch(quantity) {
        const waybill = await api('/waybills/generate', 'POST', { standard20: quantity, standard40: 0 }, 201);
        const doc = await order('receiving', 4, { transportType: 'RAILWAY',
            defaultRailwayCarriageOwnerId: source.id, waybillIds: [waybill.id] });
        await confirm('receiving', doc, 4, 'RAILWAY');
        await finish('receiving', doc);
        const rows = (await api('/receiving-orders/' + doc.id)).containers;
        return { doc, rows, ids: (await Promise.all(rows.map(stock))).map(owner => owner.id) };
    }
    async function schedule(ids) {
        const draft = await transfer(5, ids);
        const path = '/service-orders/' + draft.order.id;
        const { order } = await api(path + '/accept', 'POST');
        assert.equal(order.status, 'SCHEDULED');
        assert.equal(order.exportQueued, true);
        assert.match(order.outboundDataId, /^[0-9a-f-]{36}$/);
        return path;
    }
    const complete = await receiveBatch(2);
    const retained = await receiveBatch(1);
    const cancelled = await receiveBatch(1);
    const completePath = await schedule(complete.ids);
    const blockedPath = await schedule([...retained.ids, ...cancelled.ids]);
    const chained = await api('/service-orders', 'POST', { service: 'CHANGE_OWNER', sourceClientId: target.id,
        clientId: source.id, isDeferred: true, effectiveDate: day(6), containerOwnerIds: complete.ids }, 201);
    const chainPath = '/service-orders/' + chained.order.id;
    assert.equal((await api(chainPath + '/accept', 'POST')).order.status, 'SCHEDULED');
    assert.equal((await api(completePath + '/cancellation', 'POST', undefined, 409)).code, 'OWNERSHIP_LATER_TRANSFER');
    assert.equal((await stock(complete.rows[0])).clientId, source.id);
    assert.equal((await periods(complete.rows[0])).length, 1);
    await cancel('receiving', cancelled.doc);
    await setDay(5);
    const completed = await waitForTransfer(completePath, state => state.order.status === 'DONE');
    assert.equal(completed.order.exportQueued, true);
    assert.match(completed.order.outboundDataId, /^[0-9a-f-]{36}$/);
    assert.equal(completed.order.exportExhausted, false);
    assert.deepEqual(completed.containers.map(row => row.resultStatus), ['APPLIED', 'APPLIED']);
    const pending = await api(blockedPath);
    assert.equal(pending.order.status, 'CANCELLED');
    assert.equal(pending.order.exportQueued, false);
    assert.equal(pending.order.outboundDataId, undefined);
    assert.ok(pending.containers.every(row => row.resultStatus === 'CANCELLED'));
    await api(blockedPath + '/cancellation', 'POST', undefined, 409);
    assert.equal((await stock(complete.rows[0])).clientId, target.id);
    assert.equal((await periods(complete.rows[0])).length, 2);
    assert.equal((await api(chainPath)).order.status, 'SCHEDULED');
    await setDay(6);
    await waitForTransfer(chainPath, state => state.order.status === 'DONE');
    assert.equal((await stock(complete.rows[0])).clientId, source.id);
    assert.equal((await periods(complete.rows[0])).length, 3);
    const historical = await api('/container-storage-periods?query=' + encodeURIComponent(complete.rows[0].containerName) + '&asOf=' + day(4));
    assert.equal(historical.items.length, 1);
    for (const [offset, oldOwner, newOwner] of [[5, source.id, target.id], [6, target.id, source.id]]) {
        const immediate = await api('/service-orders', 'POST', { service: 'CHANGE_OWNER', sourceClientId: oldOwner,
            clientId: newOwner, effectiveDate: day(offset), isDeferred: false, containerOwnerIds: retained.ids }, 201);
        const result = await api('/service-orders/' + immediate.order.id + '/accept', 'POST');
        assert.equal(result.order.status, 'DONE');
        assert.equal((await stock(retained.rows[0])).clientId, newOwner);
        await api('/service-orders/' + immediate.order.id + '/cancellation', 'POST', undefined, 409);
    }
    console.log('PASS two confirmed future periods in one visit, as-of reporting and terminal cancellation');
    console.log('PASS atomic two-container transfer, scheduled shipment blocking, draft, grouped conflicts, shipment blocked by scheduled transfer, partial receiving, dated transfer, storage, repeat-visit cancellation and unnumbered TOS shipment');
}
run(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
