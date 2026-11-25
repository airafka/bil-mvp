package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;

import com.fasterxml.jackson.annotation.JsonAlias;

import java.math.BigDecimal;
import java.util.UUID;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotNull;

public record CargoRequest(
        @NotNull(message = "Груз обязателен")
        @JsonAlias("etsngCode") @JsonDeserialize(converter = EntityReference.Id.class) UUID etsngCodeId,

        @NotNull(message = "Масса обязательна")
        @DecimalMin(value = "0.001", message = "Масса должна быть больше нуля")
        @Digits(integer = 12, fraction = 3, message = "Масса должна содержать не более трёх знаков после запятой")
        @JsonAlias("wightNet") BigDecimal weight
) {
}

