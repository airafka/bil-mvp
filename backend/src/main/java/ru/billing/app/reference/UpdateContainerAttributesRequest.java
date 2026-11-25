package ru.billing.app.reference;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.math.BigDecimal;
import jakarta.validation.constraints.*;
public record UpdateContainerAttributesRequest(
    @NotNull @Positive @Digits(integer=12, fraction=3) @JsonAlias("weight") BigDecimal tareWeight,
    @Positive @Digits(integer=12, fraction=3) @JsonAlias("liftingCapacity") BigDecimal loadCapacity
) {}
