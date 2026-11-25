import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramScope, relationHighlights } from '../public/diagram.js';

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

test('references to the same destination key share a color across all panels', () => {
  const service = { source: 'container_period', columns: ['service_order_id'], target: 'service_order', target_columns: ['id'] };
  const second = { ...service, source: 'service_order_container' };
  const arrival = { source: 'container_visit', columns: ['arrival'], target: 'container_owner_history', target_columns: ['id'] };
  const departure = { ...arrival, columns: ['departure'] };
  const otherColumn = { ...arrival, target_columns: ['number'] };
  const keys = [service, second, arrival, departure, otherColumn];
  const { colors, fields } = relationHighlights(keys);
  assert.equal(colors.size, keys.length);
  assert.equal(new Set(colors.values()).size, 3);
  assert.equal(colors.get(service), colors.get(second));
  assert.equal(colors.get(arrival), colors.get(departure));
  assert.deepEqual(fields.get('service_order').get('id'), new Set([service, second]));
  assert.deepEqual(fields.get('container_visit').get('arrival'), new Set([arrival, otherColumn]));
  assert.deepEqual(colors, relationHighlights(keys.toReversed()).colors);
  const focused = relationHighlights(keys, new Set([service]));
  assert.deepEqual(focused.colors, colors);
  assert.deepEqual(focused.fields.get('service_order').get('id'), new Set([service]));
});

test('a composite destination groups by its full set of columns and preserves each mapping', () => {
  const pair = { source: 'first', columns: ['contract', 'client'], target: 'contract', target_columns: ['id', 'client_id'] };
  const reversed = { ...pair, source: 'second', columns: ['owner', 'agreement'], target_columns: ['client_id', 'id'] };
  const single = { ...pair, columns: ['contract'], target_columns: ['id'] };
  const { colors, fields } = relationHighlights([pair, reversed, single]);
  assert.equal(colors.get(pair), colors.get(reversed));
  assert.notEqual(colors.get(pair), colors.get(single));
  assert.deepEqual(fields.get('contract').get('id'), new Set([pair, reversed, single]));
  assert.deepEqual(fields.get('contract').get('client_id'), new Set([pair, reversed]));
  assert.deepEqual(reversed.target_columns, ['client_id', 'id']);
});
