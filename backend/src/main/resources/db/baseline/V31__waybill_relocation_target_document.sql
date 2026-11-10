ALTER TABLE waybill_container_relocation ADD COLUMN to_waybill_id uuid REFERENCES waybill(id);
UPDATE waybill_container_relocation SET to_waybill_id=waybill_id;
ALTER TABLE waybill_container_relocation ALTER COLUMN to_waybill_id SET NOT NULL;
ALTER TABLE waybill_container_relocation DROP CONSTRAINT waybill_container_relocation_check;
ALTER TABLE waybill_container_relocation ADD CONSTRAINT waybill_relocation_changed
    CHECK(from_railway_carriage_id<>to_railway_carriage_id OR waybill_id<>to_waybill_id);
CREATE INDEX waybill_relocation_target_document_idx ON waybill_container_relocation(to_waybill_id,created_at);
