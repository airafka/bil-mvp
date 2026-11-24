package ru.billing.app.order;

import java.util.List;
import java.util.UUID;
import java.time.LocalDateTime;

public record OrderDetails(
        UUID id,
        int code,
        UUID clientId,
        String clientName,
        TerminalAreaDetails terminalArea,
        TransportType transportType,
        FillingType fillingType,
        String status,
        List<OrderContainerDetails> containers,
        List<OrderWaybillDetails> waybills,
        List<ShippingOrderRailwayCarriageDetails> railwayCarriages,
        List<ContainerQuantityDetails> containerQuantities,
        UUID contractId,
        String contractName,
        UUID routeId,
        LocalDateTime arrivalAt,
        String consignor,
        LocalDateTime departureAt,
        String consignee,
        UUID defaultContainerOwnerId,
        String defaultContainerOwnerName,
        String authorizedRepresentative, String phone, String email, String comment, String contractType, java.time.OffsetDateTime createdAt, String transportWaybillNumber
) {
}
