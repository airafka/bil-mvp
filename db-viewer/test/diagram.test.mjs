import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramScope, orderHighlights } from '../public/diagram.js';

test('the focused diagram includes every foreign key between visible tables', () => {
  const tables = ['history', 'period', 'visit', 'container', 'outside', 'isolated'].map(name => ({ name }));
  const relations = [
    { source: 'period', target: 'history' }, { source: 'visit', target: 'history' },
    { source: 'history', target: 'container' },
    { source: 'period', target: 'visit', name: 'current_visit' },
    { source: 'period', target: 'visit', name: 'previous_visit' },
    { source: 'visit', target: 'container', columns: ['a', 'b'], target_columns: ['x', 'y'] },
    { source: 'visit', target: 'visit' },
    { source: 'outside', target: 'period' }, { source: 'visit', target: 'outside' },
  ];
  const catalog = { tables, relations };
  assert.deepEqual(diagramScope(catalog, 'history'), { tables: tables.slice(0, 4), relations: relations.slice(0, 7) });
  assert.deepEqual(diagramScope(catalog, 'isolated'), { tables: [tables[5]], relations: [] });
  assert.deepEqual(diagramScope(catalog, ''), catalog);
});

test('order references keep distinct colors across views and share them across all columns of a key', () => {
  const receiving = { name: 'order_fk', source: 'items', columns: ['document', 'client'],
    target: 'receiving_order', target_columns: ['id', 'client_id'] };
  const second = { ...receiving, source: 'history' };
  const shipping = { ...receiving, name: 'shipping_fk', target: 'shipping_order' };
  const service = { ...receiving, name: 'transfer_fk', target: 'service_order' };
  const unrelated = { ...receiving, source: 'receiving_order', target: 'client' };
  const keys = [receiving, second, shipping, service, unrelated];
  const { colors, fields } = orderHighlights(keys);
  assert.equal(new Set(colors.values()).size, 4);
  assert.equal(colors.has(unrelated), false);
  assert.deepEqual(colors, orderHighlights(keys.toReversed()).colors);
  for (const column of receiving.columns) {
    assert.deepEqual(fields.get('items').get(column), new Set([receiving, shipping, service]));
  }
  for (const column of receiving.target_columns) {
    assert.deepEqual(fields.get('receiving_order').get(column), new Set([receiving, second]));
  }
  const focused = orderHighlights(keys, new Set([receiving]));
  assert.deepEqual(focused.colors, colors);
  assert.deepEqual(focused.fields.get('receiving_order').get('id'), new Set([receiving]));
  assert.deepEqual(focused.fields.get('items').get('document'), fields.get('items').get('document'));
});
