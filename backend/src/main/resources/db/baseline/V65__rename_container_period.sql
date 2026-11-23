-- Keep rows, relation OIDs, UUIDs and incoming foreign keys in place.
ALTER TABLE public.container_ownership_period RENAME TO container_period;
ALTER TABLE public.container_owner_history RENAME COLUMN storage_period_id TO container_period_id;
ALTER TABLE public.service_order_container RENAME COLUMN container_ownership_period_id TO container_period_id;

-- PostgreSQL follows the underlying relation/attribute by OID; exposed view
-- column names and SQL inside stored function bodies need explicit changes.
ALTER VIEW public.container_owner_history_view RENAME COLUMN storage_period_id TO container_period_id;
ALTER VIEW public.container_owner_history_timeline RENAME COLUMN storage_period_id TO container_period_id;
ALTER VIEW public.service_order_container_current RENAME COLUMN container_ownership_period_id TO container_period_id;

ALTER TABLE public.container_owner_history RENAME CONSTRAINT history_storage_period_fk TO history_container_period_fk;
ALTER INDEX public.history_storage_period_idx RENAME TO history_container_period_idx;
ALTER TABLE public.service_order_container RENAME CONSTRAINT service_order_container_container_ownership_period_id_fkey
    TO service_order_container_container_period_id_fkey;

DO $migration$
DECLARE
    key_name text;
    routine regprocedure;
    definition text;
BEGIN
    FOR key_name IN SELECT conname FROM pg_constraint WHERE conrelid='public.container_period'::regclass
            AND starts_with(conname, 'container_ownership_period_')
    LOOP
        EXECUTE format('ALTER TABLE public.container_period RENAME CONSTRAINT %I TO %I',
            key_name, replace(key_name, 'container_ownership_period_', 'container_period_'));
    END LOOP;

    -- Preserve the implementations installed by V1–V64, including ownership,
    -- locks and deferred checks. Only the relation and column identifiers change.
    FOREACH routine IN ARRAY ARRAY[
        'public.apply_container_history(uuid)'::regprocedure,
        'public.check_container_visit(uuid)'::regprocedure,
        'public.check_storage_period_boundaries(uuid)'::regprocedure,
        'public.protect_storage_boundary_event()'::regprocedure,
        'public.revoke_future_ownership(uuid,text)'::regprocedure,
        'public.storage_arrival_history(uuid)'::regprocedure,
        'public.storage_receiving_order(uuid)'::regprocedure,
        'public.validate_ownership_assignment()'::regprocedure,
        'public.withdraw_ownership_period(uuid,text)'::regprocedure,
        'public.confirm_ownership_assignment(uuid,uuid,uuid,uuid,uuid,text,timestamptz)'::regprocedure,
        'public.refresh_container_owner_clients(uuid[])'::regprocedure
    ] LOOP
        definition := pg_get_functiondef(routine);
        definition := replace(definition, 'container_ownership_period', 'container_period');
        EXECUTE replace(definition, 'storage_period_id', 'container_period_id');
    END LOOP;
END
$migration$;
