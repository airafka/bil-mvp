CREATE TABLE waybill_container_relocation (
    id uuid PRIMARY KEY, batch_id uuid NOT NULL,
    waybill_id uuid NOT NULL REFERENCES waybill(id),
    waybill_container_id uuid NOT NULL REFERENCES waybill_container(id),
    container_id uuid NOT NULL REFERENCES container(id),
    from_railway_carriage_id uuid NOT NULL REFERENCES railway_carriage(id),
    to_railway_carriage_id uuid NOT NULL REFERENCES railway_carriage(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(from_railway_carriage_id<>to_railway_carriage_id)
);
CREATE INDEX waybill_relocation_document_idx ON waybill_container_relocation(waybill_id,created_at);
