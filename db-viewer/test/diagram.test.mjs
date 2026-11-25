import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramScope, fieldRelations } from '../public/diagram.js';

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

test('selecting a field follows only its own outgoing keys, including composite and off-diagram targets', () => {
  const service = { source: 'period', columns: ['order_id'], target: 'order', target_columns: ['id'] };
  const other = { ...service, source: 'visit' };
  const pair = { source: 'item', columns: ['period_id', 'order_id'], target: 'period', target_columns: ['id', 'order_id'] };
  const hidden = { ...service, target: 'outside' };
  const visible = [service, other, pair];
  const all = [...visible, hidden];
  assert.deepEqual(fieldRelations(all, visible, 'period', 'order_id'), [service, hidden]);
  assert.deepEqual(fieldRelations(all, visible, 'item', 'order_id'), [pair]);
  assert.deepEqual(fieldRelations(all, visible, 'item', 'period_id'), [pair]);
  assert.deepEqual(fieldRelations(all, visible, 'order', 'id'), [service, other]);
  assert.deepEqual(fieldRelations(all, visible, 'period', 'note'), []);
});

test('revealing an off-diagram target keeps existing tables and shows every link between them', () => {
  const tables = ['home', 'neighbor', 'target', 'unrelated'].map(name => ({ name }));
  const first = { source: 'home', target: 'neighbor' };
  const second = { source: 'neighbor', target: 'target' };
  const third = { source: 'unrelated', target: 'target' };
  const catalog = { tables, relations: [first, second, third] };
  assert.deepEqual(diagramScope(catalog, 'home', ['target']), { tables: tables.slice(0, 3), relations: [first, second] });
});
