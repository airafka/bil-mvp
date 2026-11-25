package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record OrderWaybillContainerDetails(
        UUID containerId,
        String number,
        java.math.BigDecimal grossWeight,
        java.math.BigDecimal tareWeight,
        java.math.BigDecimal netWeight,
        UUID etsngCodeId,
        String etsngCodeName,
        UUID ownerClientId, String ownerClientName, String sealNumbers, UUID sealTypeId, String sealTypeName, String type, java.math.BigDecimal loadCapacity, String owner, String status, String containerStatus
) {

    @JsonProperty("containerType")
    public String containerType() { return type; }

    @JsonProperty("liftingCapacity")
    public java.math.BigDecimal liftingCapacity() { return loadCapacity; }

    @JsonProperty("ownerContainer")
    public EntityReference ownerContainer() { return EntityReference.named(ownerClientId, ownerClientName); }

    @JsonProperty("zpuType")
    public String zpuType() { return sealTypeName; }

    @JsonProperty("zpuNumbers")
    public java.util.List<String> zpuNumbers() { return sealNumbers == null ? java.util.List.of() : java.util.List.of(sealNumbers.split(", ")); }

    @JsonProperty("etsngCode")
    public String etsngCode() { return etsngCodeName; }
}
