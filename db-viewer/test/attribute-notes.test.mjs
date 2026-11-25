import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeNote } from '../attribute-notes.mjs';

test('attribute explanations distinguish document clients, owners, tare and gross weight', () => {
  assert.match(attributeNote('receiving_order', {name:'client_id'}), /Клиент/);
  assert.match(attributeNote('container_period', {name:'client_id'}), /Собственник КТК/);
  assert.match(attributeNote('service_order', {name:'new_client_owner_id'}), /Новый собственник/);
  assert.match(attributeNote('container', {name:'weight'}), /Масса тары/);
  assert.match(attributeNote('waybill_container', {name:'weight'}), /масса брутто/);
  assert.match(attributeNote('flyway_schema_history', {name:'version'}), /версии схемы/);
});

test('database comment takes priority; blank comment uses the curated explanation', () => {
  assert.equal(attributeNote('container', {name:'weight',comment:'  Проверенное описание БД  '}), 'Проверенное описание БД');
  assert.match(attributeNote('container', {name:'weight',comment:'  '}), /Масса тары/);
});

test('unknown attributes do not invent a purpose or resolve inherited object properties', () => {
  for (const name of ['new_field', 'constructor', '__proto__']) {
    assert.match(attributeNote('__proto__', {name}), /пока не задано/);
  }
  assert.equal(attributeNote('custom', {name:'link_id'}, [{column:'link_id',target:'public.client',target_column:'id'}]),
    'Ссылка на запись public.client, поле id. Отдельное пояснение назначения пока не задано.');
});
