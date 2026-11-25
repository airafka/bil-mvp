package ru.billing.app.waybill;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.UUID;

public record WaybillProductSummary(
        UUID id,
        UUID etsngCodeId,
        String code,
        String name,
        BigDecimal weight, BigDecimal grossWeight, UUID hazardClassId, String hazardClassName,
        String signDanger, UUID dangerProductId, Integer dangerProductIdentifier, String dangerProductName, String dangerClassCode
) {

    @JsonProperty("etsngCode")
    public String etsngCode() { return code; }

    @JsonProperty("dangerProduct")
    public EntityReference dangerProduct() { return EntityReference.named(dangerProductId, dangerProductName); }

    @JsonProperty("etsngName")
    public String etsngName() { return name; }

    @JsonProperty("dangerClass")
    public String dangerClass() { return hazardClassName; }
}
