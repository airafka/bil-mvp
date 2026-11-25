package ru.billing.app.reference;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.UUID;
import java.math.BigDecimal;
import java.time.LocalDate;
public record RailwayCarriageReferenceOption(UUID id, String name, UUID modelId, String modelName,
        BigDecimal loadCapacity, LocalDate nextDepotRepairDate, UUID carriageTypeId, String carriageTypeName, String typeCode) {
    @JsonProperty("code")
    public String code() { return name; }

    @JsonProperty("liftingCapacity")
    public BigDecimal liftingCapacity() { return loadCapacity; }

    @JsonProperty("dateDepotRepair")
    public LocalDate dateDepotRepair() { return nextDepotRepairDate; }

    @JsonProperty("model")
    public EntityReference model() { return EntityReference.coded(modelId, modelName); }

    @JsonProperty("type")
    public EntityReference type() { return carriageTypeId == null ? null : new EntityReference(carriageTypeId, typeCode, carriageTypeName); }
}
