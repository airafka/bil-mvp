package ru.billing.app.order;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.UUID;

public record OrderWaybillCarriageDetails(
        UUID id,
        UUID railwayCarriageId,
        String number,
        String typeName,
        String modelName,
        java.math.BigDecimal loadCapacity,
        java.time.LocalDate nextDepotRepairDate,
        List<OrderWaybillContainerDetails> containers
) {

    @JsonProperty("liftingCapacity")
    public java.math.BigDecimal liftingCapacity() { return loadCapacity; }

    @JsonProperty("dateDepotRepair")
    public java.time.LocalDate dateDepotRepair() { return nextDepotRepairDate; }

    @JsonProperty("type")
    public String type() { return typeName; }

    @JsonProperty("model")
    public String model() { return modelName; }
}
