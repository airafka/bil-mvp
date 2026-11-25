package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.UUID;

public record OrderWaybillProductDetails(
        UUID id,
        UUID etsngCodeId,
        String etsngCode,
        BigDecimal weight, BigDecimal grossWeight, UUID hazardClassId, String hazardClassName,
        String signDanger, UUID dangerProductId, Integer dangerProductIdentifier, String dangerProductName, String dangerClassCode
) {

    @JsonProperty("dangerProduct")
    public EntityReference dangerProduct() { return EntityReference.named(dangerProductId, dangerProductName); }

    @JsonProperty("dangerClass")
    public String dangerClass() { return hazardClassName; }
}
