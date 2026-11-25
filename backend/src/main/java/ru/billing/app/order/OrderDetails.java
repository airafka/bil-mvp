package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

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
        @JsonProperty("consigneeName") String consignee,
        UUID defaultContainerOwnerId,
        String defaultContainerOwnerName,
        String authorizedRepresentative, String phone, String email, String comment, String contractType, java.time.OffsetDateTime createdAt, String transportWaybillNumber, UUID shipperId, UUID consigneeId
) {
    @JsonProperty("number")
    public int number() { return code; }

    @JsonProperty("orderStatus")
    public String orderStatus() { return status; }

    @JsonProperty("planReceivingDateTime")
    public LocalDateTime planReceivingDateTime() { return arrivalAt; }

    @JsonProperty("plannedShippingDateTime")
    public LocalDateTime plannedShippingDateTime() { return departureAt; }

    @JsonProperty("shipper")
    public EntityReference shipper() { return EntityReference.named(shipperId, consignor); }

    @JsonProperty("consignee")
    public EntityReference consigneeReference() { return EntityReference.named(consigneeId, consignee); }

    @JsonProperty("waybill")
    public String waybill() { return transportWaybillNumber; }

    @JsonProperty("client")
    public EntityReference client() { return EntityReference.named(clientId, clientName); }

    @JsonProperty("contract")
    public EntityReference contract() { return EntityReference.named(contractId, contractName); }

    @JsonProperty("defaultContainerOwner")
    public EntityReference defaultContainerOwner() { return EntityReference.named(defaultContainerOwnerId, defaultContainerOwnerName); }

    @JsonProperty("route")
    public EntityReference route() { return EntityReference.named(routeId, null); }
}
