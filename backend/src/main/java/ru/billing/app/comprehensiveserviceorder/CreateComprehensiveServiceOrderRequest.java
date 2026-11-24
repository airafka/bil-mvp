package ru.billing.app.comprehensiveserviceorder;

import java.util.List;
import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;

public record CreateComprehensiveServiceOrderRequest(
        @NotNull(message = "Клиент обязателен") UUID clientId,
        @NotNull(message = "Договор обязателен") UUID contractId,
        @NotEmpty(message = "Выберите хотя бы одну накладную") List<@NotNull UUID> waybillIds,
        UUID defaultContainerOwnerId,
        @Size(max = 10000) List<@NotNull @Valid ContainerOwner> containerOwners, UUID defaultRailwayCarriageOwnerId
) {
    public record ContainerOwner(@NotNull UUID containerId, @NotNull UUID ownerClientId) {}
    public CreateComprehensiveServiceOrderRequest { containerOwners = containerOwners == null ? List.of() : List.copyOf(containerOwners); }
}
