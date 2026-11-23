package ru.billing.app.order;

import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

public record ContainerQuantityRequest(
        @NotNull(message = "Количество КТК обязательно")
        Integer quantity,
        @NotNull(message = "Тип КТК обязателен")
        ContainerType type,
        @NotNull(message = "Признак порожнего КТК обязателен")
        Boolean empty,
        List<@NotNull(message = "Данные груза обязательны") @Valid CargoRequest> items, java.util.UUID ownerClientId
) {
    public ContainerQuantityRequest(Integer quantity, ContainerType type, Boolean empty, List<CargoRequest> items) {
        this(quantity, type, empty, items, null);
    }
}
