package ru.billing.app.order;

import java.util.UUID;

public record ContainerQuantityDetails(
        UUID id,
        int quantity,
        ContainerType type,
        boolean empty,
        UUID ownerClientId, String ownerName
) {
}
