package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.UUID;

public record OrderCargoDetails(
        UUID etsngCodeId,
        String etsngCodeName,
        BigDecimal weight
) {

    @JsonProperty("wightNet")
    public BigDecimal wightNet() { return weight; }

    @JsonProperty("etsngCode")
    public EntityReference etsngCode() { return EntityReference.coded(etsngCodeId, etsngCodeName); }
}
