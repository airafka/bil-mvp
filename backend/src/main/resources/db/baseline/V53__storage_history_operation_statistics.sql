-- Recursive origin queries must estimate the distribution of computed history operations.
-- Expression statistics contain planner metadata, not a stored business column.
CREATE STATISTICS history_operation_estimate ON (history_operation_type(order_type,old_status,new_status))
 FROM container_owner_history;
ANALYZE container_owner_history;
COMMENT ON STATISTICS history_operation_estimate IS 'Статистика вычисляемого типа события для плана рекурсивного отчёта хранения без хранимого operation_type/arrival_history_id.';
