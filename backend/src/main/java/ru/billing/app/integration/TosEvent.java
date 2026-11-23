package ru.billing.app.integration;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@JsonIgnoreProperties(ignoreUnknown = true)
public record TosEvent(
        @NotNull @JsonProperty("_id") UUID taskId, @NotNull @JsonProperty("_order") UUID orderId,
        @NotNull String orderNumber, @NotNull String source, @NotBlank String site, @NotNull String eventName,
        @NotBlank String eventCode, @NotNull OffsetDateTime eventDateTime,
        List<@Valid @NotNull Cargo> cargoResult, List<@Valid @NotNull ExtraService> addServicesResult) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Cargo(@NotBlank String cargoNumber, @NotBlank String cargoType, @NotNull BigDecimal qty,
            @NotBlank String transportType, @NotBlank String transportNumber, @NotNull Boolean active,
            List<@NotNull @Valid Seal> seals, List<@NotNull @Valid CargoItem> cargoSpec) {
        public Cargo {
            seals = seals == null ? List.of() : seals;
            cargoSpec = cargoSpec == null ? List.of() : cargoSpec;
        }
    }
    public record Seal(String code) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record CargoItem(String code, BigDecimal qty) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ExtraService(@NotNull BigDecimal qty, @Valid @NotNull Operation operationType) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Operation(@JsonProperty("_id") @NotNull UUID id) {}
    public TosEvent {
        cargoResult = cargoResult == null ? List.of() : cargoResult;
        addServicesResult = addServicesResult == null ? List.of() : addServicesResult;
    }
}
