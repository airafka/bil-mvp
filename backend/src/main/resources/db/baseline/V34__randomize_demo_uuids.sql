-- Replace only the recognisable IDs of the old demo seeds. Real random UUIDs stay unchanged.
-- Flyway runs this migration in one transaction: locks, remapping and FK validation are atomic.
SET LOCAL lock_timeout = '15s';

CREATE TEMP TABLE demo_uuid_columns ON COMMIT DROP AS
SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
       a.atttypid::regtype::text AS data_type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  -- Flyway holds its own history lock on a separate connection; it has no business UUIDs.
  AND c.relname <> 'flyway_schema_history'
  AND a.attnum > 0 AND NOT a.attisdropped
  AND a.atttypid IN ('uuid'::regtype, 'text'::regtype, 'varchar'::regtype,
                    'json'::regtype, 'jsonb'::regtype);

CREATE TEMP TABLE demo_uuid_seen (id uuid PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE demo_uuid_map (old_id uuid PRIMARY KEY, new_id uuid NOT NULL UNIQUE) ON COMMIT DROP;
CREATE TEMP TABLE demo_uuid_fks ON COMMIT DROP AS
SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname AS constraint_name,
       pg_get_constraintdef(c.oid) AS definition, obj_description(c.oid, 'pg_constraint') AS comment
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype = 'f' AND n.nspname = 'public';

DO $$
DECLARE
    col record;
    candidate uuid;
    generated uuid;
BEGIN
    -- Do not silently miss a reference introduced outside the application's schema.
    IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
               JOIN pg_class p ON p.oid = c.confrelid
               WHERE c.contype = 'f' AND p.relnamespace = 'public'::regnamespace
                 AND t.relnamespace <> 'public'::regnamespace) THEN
        RAISE EXCEPTION 'UUID migration needs review: an external schema references public';
    END IF;
    FOR col IN SELECT DISTINCT schema_name, table_name FROM demo_uuid_columns ORDER BY 1, 2 LOOP
        EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', col.schema_name, col.table_name);
    END LOOP;

    -- Include polymorphic UUID columns and UUID tokens in JSON archives / operation keys.
    -- Also collect real UUIDs so newly generated values cannot collide with existing identities.
    FOR col IN SELECT * FROM demo_uuid_columns LOOP
        IF col.data_type = 'uuid' THEN
            EXECUTE format('INSERT INTO demo_uuid_seen SELECT %I FROM %I.%I WHERE %I IS NOT NULL ON CONFLICT DO NOTHING',
                           col.column_name, col.schema_name, col.table_name, col.column_name);
        ELSE
            EXECUTE format('INSERT INTO demo_uuid_seen SELECT (regexp_matches(%I::text, %L, ''gi''))[1]::uuid
                            FROM %I.%I ON CONFLICT DO NOTHING', col.column_name,
                           '\m[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\M',
                           col.schema_name, col.table_name);
        END IF;
    END LOOP;
    FOR candidate IN SELECT id FROM demo_uuid_seen
                     WHERE id::text ~ '^[0-9a-f]{8}-0000-(0000-0000|4000-8000)-000000[0-9a-f]{6}$' LOOP
        LOOP
            generated := gen_random_uuid();
            EXIT WHEN NOT EXISTS (SELECT 1 FROM demo_uuid_seen WHERE id = generated)
                      AND NOT EXISTS (SELECT 1 FROM demo_uuid_map WHERE new_id = generated);
        END LOOP;
        INSERT INTO demo_uuid_map VALUES (candidate, generated);
    END LOOP;
END $$;

CREATE FUNCTION pg_temp.remap_demo_uuid_tokens(value text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE mapping record;
BEGIN
    FOR mapping IN SELECT * FROM demo_uuid_map LOOP
        value := regexp_replace(value, '\m' || mapping.old_id::text || '\M', mapping.new_id::text, 'gi');
    END LOOP;
    RETURN value;
END $$;

DO $$
DECLARE col record; fk record; changed_ids integer;
BEGIN
    SELECT count(*) INTO changed_ids FROM demo_uuid_map;
    IF changed_ids = 0 THEN RETURN; END IF;

    -- Several FKs use RESTRICT, and history/periods form a cycle. Drop and recreate exact
    -- definitions under exclusive locks instead of disabling triggers or leaving deferred checks.
    FOR fk IN SELECT * FROM demo_uuid_fks LOOP
        EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', fk.schema_name, fk.table_name, fk.constraint_name);
    END LOOP;
    FOR col IN SELECT * FROM demo_uuid_columns LOOP
        IF col.data_type = 'uuid' THEN
            EXECUTE format('UPDATE %I.%I t SET %I = m.new_id FROM demo_uuid_map m WHERE t.%I = m.old_id',
                           col.schema_name, col.table_name, col.column_name, col.column_name);
        ELSE
            EXECUTE format('UPDATE %I.%I SET %I = pg_temp.remap_demo_uuid_tokens(%I::text)::%s
                            WHERE %I::text ~* %L',
                           col.schema_name, col.table_name, col.column_name, col.column_name, col.data_type,
                           col.column_name, '\m[0-9a-f]{8}-0000-(0000-0000|4000-8000)-000000[0-9a-f]{6}\M');
        END IF;
    END LOOP;
    FOR fk IN SELECT * FROM demo_uuid_fks LOOP
        EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
                       fk.schema_name, fk.table_name, fk.constraint_name, fk.definition);
        IF fk.comment IS NOT NULL THEN
            EXECUTE format('COMMENT ON CONSTRAINT %I ON %I.%I IS %L',
                           fk.constraint_name, fk.schema_name, fk.table_name, fk.comment);
        END IF;
    END LOOP;
    RAISE NOTICE 'Replaced % distinct demo UUIDs and their references', changed_ids;
END $$;

DROP FUNCTION pg_temp.remap_demo_uuid_tokens(text);
