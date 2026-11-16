-- The override changes business dates, never the host clock or existing records.
CREATE TABLE application_clock (
    id smallint PRIMARY KEY CHECK (id = 1),
    business_date date CHECK (business_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
    version bigint NOT NULL DEFAULT 0,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO application_clock(id) VALUES (1);

CREATE FUNCTION billing_now() RETURNS timestamptz
LANGUAGE plpgsql VOLATILE AS $$
DECLARE chosen date; actual timestamptz;
BEGIN
    -- A calendar change waits for operations already using this date to finish.
    -- Advisory locks also work in read-only report transactions.
    PERFORM pg_advisory_xact_lock_shared(353535, 1);
    SELECT business_date INTO STRICT chosen FROM public.application_clock WHERE id = 1;
    actual := clock_timestamp();
    IF chosen IS NULL THEN RETURN actual; END IF;
    RETURN (chosen + (actual AT TIME ZONE 'Europe/Moscow')::time) AT TIME ZONE 'Europe/Moscow';
END $$;

CREATE FUNCTION billing_today() RETURNS date
LANGUAGE sql VOLATILE AS $$ SELECT (public.billing_now() AT TIME ZONE 'Europe/Moscow')::date $$;

-- Keep each existing column's timezone contract. Technical migration/setting timestamps remain real.
DO $$ DECLARE col record; BEGIN
    FOR col IN
        SELECT table_name,column_name,data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name NOT IN ('flyway_schema_history','application_clock')
          AND data_type IN ('timestamp with time zone','timestamp without time zone')
          AND column_default ~* '(current_timestamp|now\(\)|clock_timestamp\(\))'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s', col.table_name,col.column_name,
            CASE WHEN col.data_type='timestamp with time zone' THEN 'public.billing_now()'
                 ELSE '(public.billing_now() AT TIME ZONE ''UTC'')' END);
    END LOOP;
END $$;
