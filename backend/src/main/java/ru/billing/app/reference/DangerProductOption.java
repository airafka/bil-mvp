package ru.billing.app.reference;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.UUID;
public record DangerProductOption(UUID id, Integer identifier, String name, UUID dangerClassId, String dangerClassName, String dangerClassCode) {
    @JsonProperty("dangerClass")
    public EntityReference dangerClass() { return dangerClassId == null ? null : new EntityReference(dangerClassId, dangerClassName, null); }
}
