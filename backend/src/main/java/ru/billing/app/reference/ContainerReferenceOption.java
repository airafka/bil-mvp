package ru.billing.app.reference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record ContainerReferenceOption(UUID id, String name, String type, java.math.BigDecimal tareWeight, java.math.BigDecimal loadCapacity) {

    @JsonProperty("code")
    public String code() { return name; }

    @JsonProperty("containerType")
    public String containerType() { return type; }

    @JsonProperty("weight")
    public java.math.BigDecimal weight() { return tareWeight; }

    @JsonProperty("liftingCapacity")
    public java.math.BigDecimal liftingCapacity() { return loadCapacity; }
}
