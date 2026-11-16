-- Refuse to discard unresolved legacy findings without explicit reconciliation.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM container_owner_history WHERE needs_review) THEN
        RAISE EXCEPTION 'Container history requires review before removing review fields';
    END IF;
END $$;

ALTER TABLE container_owner_history
    DROP COLUMN target_history_id,
    DROP COLUMN source_system,
    DROP COLUMN source_operation_key,
    DROP COLUMN reason,
    DROP COLUMN needs_review,
    DROP COLUMN review_reason;
