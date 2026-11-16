// Mutating checks are restricted to a separately restored billing_uuid_test database.
// All fixtures and both migration runs are rolled back. Never points at billing_next.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const docker = process.env.DOCKER_EXE || 'docker';
const target = 'billing_uuid_test';
const args = ['exec', '-i', 'billing-next-db-1', 'psql', '-X', '-U', 'billing', '-d', target, '-At', '-v', 'ON_ERROR_STOP=1'];
const run = input => execFileSync(docker, args, {input, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024}).trim();
assert.equal(run('select current_database();'), target);
assert.equal(run('select max(version::int) from flyway_schema_history where success;'), '33');
const migration = fs.readFileSync(path.join(__dirname, '../backend/src/main/resources/db/baseline/V34__randomize_demo_uuids.sql'), 'utf8');
const snapshotSql = `DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
    EXECUTE format('INSERT INTO uuid_check_rows SELECT %L, to_jsonb(t) FROM public.%I t', t.tablename, t.tablename);
  END LOOP;
END $$;`;
const schemaSql = `SELECT n.nspname, t.relname, c.conname, c.contype, c.convalidated,
  pg_get_constraintdef(c.oid), obj_description(c.oid,'pg_constraint')
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='public'`;
const persisted = run(`select jsonb_agg(r order by id)::text from container r;`);
const result = run(`BEGIN;
DO $$ BEGIN IF current_database() <> 'billing_uuid_test' THEN RAISE EXCEPTION 'Wrong database'; END IF; END $$;
CREATE TABLE public.uuid_check_parent(id uuid PRIMARY KEY, child_id uuid, archive jsonb, operation_key varchar(200), note text);
CREATE TABLE public.uuid_check_child(id uuid PRIMARY KEY, parent_id uuid REFERENCES public.uuid_check_parent(id) ON DELETE RESTRICT,
  polymorphic_id uuid, unchanged_id uuid);
ALTER TABLE public.uuid_check_parent ADD CONSTRAINT uuid_check_cycle FOREIGN KEY(child_id) REFERENCES public.uuid_check_child(id) ON DELETE SET NULL;
COMMENT ON CONSTRAINT uuid_check_cycle ON public.uuid_check_parent IS 'Preserve FK comments and actions';
INSERT INTO public.uuid_check_parent VALUES ('e1234000-0000-4000-8000-000000000001',NULL,
  '{"id":"E1234000-0000-4000-8000-000000000001","nested":[{"deletedId":"e1234000-0000-0000-0000-000000000003","amount":1234567890123456789.12}],"e1234000-0000-4000-8000-000000000002":"archived"}',
  'RECEIVING_ORDER:e1234000-0000-4000-8000-000000000001:e1234000-0000-4000-8000-000000000002:ARRIVAL',
  'Keep number 52554, cargo name and dates unchanged');
INSERT INTO public.uuid_check_child VALUES ('e1234000-0000-4000-8000-000000000002','e1234000-0000-4000-8000-000000000001',
  'e1234000-0000-0000-0000-000000000003','8888c951-b4c3-46a1-87c3-1266c99bcc62');
UPDATE public.uuid_check_parent SET child_id='e1234000-0000-4000-8000-000000000002';
CREATE TEMP TABLE uuid_check_rows(table_name text, row_data jsonb);
${snapshotSql}
CREATE TEMP TABLE uuid_check_expected AS TABLE uuid_check_rows;
CREATE TEMP TABLE uuid_check_schema AS ${schemaSql};
${migration}
DO $$ DECLARE m record; changed integer; BEGIN
  SELECT count(*) INTO changed FROM demo_uuid_map;
  IF changed < 3 THEN RAISE EXCEPTION 'Fixtures were not remapped'; END IF;
  IF EXISTS(SELECT 1 FROM demo_uuid_map WHERE new_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    THEN RAISE EXCEPTION 'Not random UUID v4'; END IF;
  -- Independent expected snapshot: only substitute the mapped UUID tokens, keeping exact JSON numbers.
  FOR m IN SELECT * FROM demo_uuid_map LOOP
    UPDATE uuid_check_expected SET row_data=regexp_replace(row_data::text,'\\m'||m.old_id::text||'\\M',m.new_id::text,'gi')::jsonb;
  END LOOP;
  RAISE NOTICE 'Tested % UUID mappings',changed;
END $$;
TRUNCATE uuid_check_rows;
${snapshotSql}
DO $$ BEGIN
  IF EXISTS((TABLE uuid_check_expected EXCEPT ALL TABLE uuid_check_rows) UNION ALL
            (TABLE uuid_check_rows EXCEPT ALL TABLE uuid_check_expected)) THEN
    RAISE EXCEPTION 'Lost/changed rows, random UUIDs or business data, or missed reference';
  END IF;
  IF EXISTS(SELECT 1 FROM uuid_check_rows WHERE row_data::text ~* '[0-9a-f]{8}-0000-(0000-0000|4000-8000)-000000[0-9a-f]{6}') THEN
    RAISE EXCEPTION 'Demo UUID remains';
  END IF;
  IF EXISTS((TABLE uuid_check_schema EXCEPT ALL ${schemaSql}) UNION ALL
            (${schemaSql} EXCEPT ALL TABLE uuid_check_schema)) THEN
    RAISE EXCEPTION 'Constraint definitions, validation or comments changed';
  END IF;
END $$;
DROP TABLE demo_uuid_columns,demo_uuid_seen,demo_uuid_map,demo_uuid_fks;
${migration}
DO $$ BEGIN IF EXISTS(SELECT 1 FROM demo_uuid_map) THEN RAISE EXCEPTION 'Second run must be a no-op'; END IF; END $$;
TRUNCATE uuid_check_rows;
${snapshotSql}
DO $$ BEGIN
  IF EXISTS((TABLE uuid_check_expected EXCEPT ALL TABLE uuid_check_rows) UNION ALL
            (TABLE uuid_check_rows EXCEPT ALL TABLE uuid_check_expected)) THEN RAISE EXCEPTION 'Second run changed rows'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: all rows and random IDs preserved, UUID/JSON/key/polymorphic references remapped, cyclic FKs validated, repeat run unchanged';`);
assert.match(result, /PASS:/);
assert.equal(run(`select jsonb_agg(r order by id)::text from container r;`), persisted);
assert.equal(run(`select count(*) from pg_tables where schemaname='public' and tablename like 'uuid_check_%';`), '0');
console.log(result.split('\n').find(line => line.startsWith('PASS:')));
console.log('PASS: transaction rollback restored the test database');
