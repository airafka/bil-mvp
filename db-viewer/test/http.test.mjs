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
