import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('HTTP reads every table and rejects mutations, unknown identifiers and foreign origins',
  { skip: !process.env.VIEWER_URL }, async () => {
    const url = process.env.VIEWER_URL;
    const overview = await fetch(url + '/api/tables').then(r => r.json());
    assert.ok(overview.tables.length > 0);
    assert.ok(overview.tables.every(t => t.observed), 'All existing tables must emit events');
    for (const table of overview.tables) {
      const result = await fetch(url + '/api/table?name=' + encodeURIComponent(table.name));
      assert.equal(result.status, 200, table.name);
      const data = await result.json();
      assert.equal(data.name, table.name); assert.ok(data.columns.length > 0);
      assert.ok(data.columns.every(column => typeof column.note === 'string' && column.note.length > 0), table.name + ' attribute notes');
      assert.ok(data.rows.length <= 50);
    }
    assert.equal((await fetch(url + '/api/tables', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/api/tables', { headers: { Origin: 'https://foreign.example' } })).status, 403);
    const foreignHostStatus = await new Promise((resolve, reject) => {
      http.get(url + '/api/tables', { headers: { Host: 'foreign.example:3002' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(url + '/api/table?name=unknown')).status, 400);
    assert.equal((await fetch(url + '/api/table?name=client&limit=100000')).status, 400);
    console.log(`Read-only HTTP checks passed for ${overview.tables.length} tables`);
  });

test('period dates come from the linked history event and support sorting and search',
  { skip: !process.env.VIEWER_URL }, async () => {
    const page = async params => {
      const response = await fetch(process.env.VIEWER_URL + '/api/table?' + new URLSearchParams(params));
      assert.equal(response.status, 200);
      return response.json();
    };
    const periods = await page({ name: 'container_period', sort: 'effective_at', direction: 'asc' });
    const dateColumn = periods.columns.find(c => c.name === 'effective_at');
    assert.equal(dateColumn?.derived, true);
    assert.equal(dateColumn.label, 'Действует с');
    let previous;
    for (const row of periods.rows) {
      const event = await page({ name: 'container_owner_history', column: 'id', value: row.start_container_owner_history_id });
      assert.equal(event.rows[0].occurred_at, row.effective_at);
      if (previous) assert.ok(Date.parse(previous) <= Date.parse(row.effective_at));
      previous = row.effective_at;
    }
    if (previous) {
      const matches = await page({ name: 'container_period', search: previous, column: 'effective_at', value: previous });
      assert.ok(matches.rows.length > 0);
      assert.ok(matches.rows.every(row => row.effective_at === previous));
    }
  });
