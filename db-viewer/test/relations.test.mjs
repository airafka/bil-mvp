import test from 'node:test';
import assert from 'node:assert/strict';

test('every exposed foreign key uses all its columns to find the related record',
  { skip: !process.env.VIEWER_URL }, async () => {
    const url = process.env.VIEWER_URL;
    const page = async params => {
      const response = await fetch(url + '/api/table?' + params);
      assert.equal(response.status, 200, params.toString());
      return response.json();
    };
    const { tables } = await fetch(url + '/api/tables').then(r => r.json());
    let keys = 0, followed = 0, composite = 0;
    for (const table of tables) {
      const data = await page(new URLSearchParams({ name: table.name, limit: '100' }));
      if (['receiving_order', 'shipping_order'].includes(table.name)) {
        for (const [column, target, parts] of [
          ['contract_id', 'contract', ['contract_id', 'client_id']],
          ['comprehensive_service_order_id', 'comprehensive_service_order', ['comprehensive_service_order_id', 'client_id', 'contract_id']],
        ]) {
          const relation = data.relations.find(r => r.column === column);
          assert.equal(relation?.target.replace(/^public\./, ''), target);
          assert.deepEqual(relation.columns, parts);
        }
        assert.equal(data.relations.find(r => r.column === 'client_id').target.replace(/^public\./, ''), 'client');
      }
      const checked = new Set();
      for (const relation of data.relations) {
        const signature = JSON.stringify([relation.target, relation.columns, relation.target_columns]);
        if (checked.has(signature)) continue;
        checked.add(signature); keys++;
        if (relation.columns.length > 1) composite++;
        assert.equal(relation.columns.length, relation.target_columns.length);
        const target = relation.target.replace(/^public\./, '');
        assert.ok(tables.some(t => t.name === target));
        const source = data.rows.find(row => relation.columns.every(column => row[column] != null));
        if (!source) continue;
        const params = new URLSearchParams({ name: target });
        relation.columns.forEach((column, index) => {
          params.append('column', relation.target_columns[index]); params.append('value', source[column]);
        });
        const related = await page(params);
        assert.equal(related.total, '1', table.name + ' -> ' + signature);
        relation.columns.forEach((column, index) => assert.equal(related.rows[0][relation.target_columns[index]], source[column]));
        if (relation.columns.length > 1) {
          const mismatch = new URLSearchParams({ name: target });
          relation.columns.forEach((column, index) => {
            mismatch.append('column', relation.target_columns[index]);
            mismatch.append('value', index === relation.columns.length - 1 ? '__no_matching_key__' : source[column]);
          });
          assert.equal((await page(mismatch)).total, '0', 'All key parts must constrain the result');
        }
        followed++;
      }
    }
    assert.ok(composite > 0); assert.ok(followed > 0);
    for (const query of ['column=id', 'value=1', 'column=missing&value=1', 'column=id&value=1&column=missing&value=2']) {
      assert.equal((await fetch(url + '/api/table?name=client&' + query)).status, 400);
    }
    console.log('Read-only relation checks: ' + tables.length + ' tables, ' + keys + ' keys (' + composite + ' composite), ' + followed + ' linked records checked');
  });
