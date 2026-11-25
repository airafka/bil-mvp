package ru.billing.app.reference;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.UUID;
import java.math.BigDecimal;
import java.time.LocalDate;
import jakarta.validation.constraints.*;
public record UpdateRailwayCarriageRequest(@JsonAlias("model") @JsonDeserialize(converter = EntityReference.Id.class) UUID modelId,
        @DecimalMin(value = "0", inclusive = false, message = "Грузоподъёмность должна быть положительной")
        @Digits(integer = 12, fraction = 3, message = "Грузоподъёмность: до 12 цифр и 3 знаков после запятой") @JsonAlias("liftingCapacity") BigDecimal loadCapacity,
        @JsonAlias("dateDepotRepair") LocalDate nextDepotRepairDate, @JsonAlias("type") @JsonDeserialize(converter = EntityReference.Id.class) UUID carriageTypeId) {}
