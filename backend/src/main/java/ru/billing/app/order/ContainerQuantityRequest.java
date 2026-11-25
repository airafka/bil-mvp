package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;

import com.fasterxml.jackson.annotation.JsonAlias;

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
        List<@NotNull(message = "Данные груза обязательны") @Valid CargoRequest> items, @JsonAlias("ownerClient") @JsonDeserialize(converter = EntityReference.Id.class) java.util.UUID ownerClientId
) {
    public ContainerQuantityRequest(Integer quantity, ContainerType type, Boolean empty, List<CargoRequest> items) {
        this(quantity, type, empty, items, null);
    }
}
