ALTER TABLE service_order ADD COLUMN effective_date date;
ALTER TABLE service_order DROP CONSTRAINT service_order_status_check;
ALTER TABLE service_order ADD CONSTRAINT service_order_status_check CHECK (status IN ('DRAFT','SCHEDULED','DONE'));
ALTER TABLE service_order ADD CONSTRAINT service_order_schedule_check
    CHECK (status <> 'SCHEDULED' OR (effective_date IS NOT NULL AND completion_at IS NULL));
ALTER TABLE service_order ADD CONSTRAINT service_order_effective_date_check
    CHECK (effective_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31');
CREATE INDEX ix_service_order_due ON service_order(effective_date,id) WHERE status='SCHEDULED';
COMMENT ON COLUMN service_order.effective_date IS 'Дата передачи КТК по рабочему календарю Europe/Moscow. NULL у прежних заявок, дата которых не задавалась. Новые подтверждённые заявки ожидают выполнения до этой даты.';
COMMENT ON COLUMN service_order.status IS 'DRAFT — черновик; SCHEDULED — ожидает выполнения; DONE — выполнена. В ожидании updated_at сохраняет бизнес-время подтверждения.';
