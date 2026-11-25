package ru.billing.app.waybill;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public record WaybillCarriageSummary(UUID id, String number, List<WaybillContainerSummary> containers,
        String typeName, String modelName, BigDecimal loadCapacity, LocalDate nextDepotRepairDate, UUID railwayCarriageId) {
    @JsonProperty("liftingCapacity")
    public java.math.BigDecimal liftingCapacity() { return loadCapacity; }

    @JsonProperty("dateDepotRepair")
    public java.time.LocalDate dateDepotRepair() { return nextDepotRepairDate; }

    @JsonProperty("type")
    public String type() { return typeName; }

    @JsonProperty("model")
    public String model() { return modelName; }
}
