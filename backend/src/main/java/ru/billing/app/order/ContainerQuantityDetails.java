package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record ContainerQuantityDetails(
        UUID id,
        int quantity,
        ContainerType type,
        boolean empty,
        UUID ownerClientId, String ownerName
) {

    @JsonProperty("ownerClient")
    public EntityReference ownerClient() { return EntityReference.named(ownerClientId, ownerName); }
}
