import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { quote, installObserver, connection, read, pool, CHANNEL, tablePage } from '../database.mjs';

test('SQL identifiers are quoted, never executed', () => {
  assert.equal(quote('a"; DROP TABLE client; --'), '"a""; DROP TABLE client; --"');
});

test('observer sends committed INSERT/UPDATE/DELETE/TRUNCATE; rollback is silent; reads are read-only',
  { skip: !process.env.VIEWER_INTEGRATION }, async () => {
    assert.equal(connection.database, 'billing_db_viewer_test', 'Never run mutation tests on the working DB');
    const writer = new pg.Client(connection), listener = new pg.Client(connection);
    const events = [];
    let wake;
    listener.on('notification', event => { events.push(JSON.parse(event.payload)); wake?.(); });
    const until = async predicate => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Expected database notification');
        await new Promise(resolve => { const timer = setTimeout(resolve, 100); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    };
    try {
      await writer.connect(); await listener.connect();
      await writer.query('CREATE TABLE IF NOT EXISTS viewer_test_record (id bigint PRIMARY KEY, note text)');
      await writer.query('ALTER TABLE viewer_test_record ADD COLUMN IF NOT EXISTS occurred_at timestamptz');
      await writer.query('TRUNCATE viewer_test_record');
      await installObserver(writer); await installObserver(writer);
      await listener.query(`LISTEN ${CHANNEL}`);
      await writer.query('BEGIN');
      await writer.query("INSERT INTO viewer_test_record (id, note, occurred_at) VALUES (9007199254740993, 'new row', '2026-11-30 00:00:00.123456+03')");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(events.length, 0, 'Uncommitted changes must not be delivered');
      await writer.query('COMMIT'); await until(() => events.length === 1);
      assert.equal(events[0].operation, 'INSERT');
      const page = await tablePage(new URLSearchParams({ name: 'viewer_test_record' }));
      assert.equal(page.rows[0].id, '9007199254740993', 'BIGINT must retain precision');
      assert.equal(page.rows[0].occurred_at, '2026-11-29 21:00:00.123456+00');
      await writer.query("UPDATE viewer_test_record SET note='updated'"); await until(() => events.length === 2);
      assert.equal(events[1].operation, 'UPDATE');
      await writer.query('BEGIN'); await writer.query('DELETE FROM viewer_test_record'); await writer.query('ROLLBACK');
      await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(events.length, 2);
      await writer.query('DELETE FROM viewer_test_record'); await until(() => events.length === 3);
      await writer.query('TRUNCATE viewer_test_record'); await until(() => events.length === 4);
      assert.deepEqual(events.map(e => e.operation), ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']);
      await assert.rejects(read(client => client.query("INSERT INTO viewer_test_record VALUES(2,'forbidden')")), /read-only/);
      await assert.rejects(tablePage(new URLSearchParams({ name: 'viewer_test_record; DROP TABLE viewer_test_record' })), /не найдена/);
      await assert.rejects(tablePage(new URLSearchParams({ name: 'viewer_test_record', sort: 'invalid' })), /Неизвестная/);
      const none = await tablePage(new URLSearchParams({ name: 'viewer_test_record', search: "' OR 1=1 --" }));
      assert.equal(none.rows.length, 0);
    } finally {
      await writer.end(); await listener.end(); await pool.end();
    }
  });
