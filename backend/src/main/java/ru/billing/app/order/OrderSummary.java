package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;
import java.time.LocalDateTime;

public record OrderSummary(
        UUID id,
        Integer code,
        UUID clientId,
        String clientName,
        TerminalAreaDetails terminalArea,
        TransportType transportType,
        FillingType fillingType,
        String status,
        UUID contractId,
        String contractName,
        LocalDateTime planReceivingDateTime,
        LocalDateTime plannedShippingDateTime,
        UUID routeId,
        Integer routeNumber,
        String comment
) {
    @JsonProperty("number")
    public Integer number() { return code; }

    @JsonProperty("orderStatus")
    public String orderStatus() { return status; }

    @JsonProperty("plannedAt")
    public LocalDateTime plannedAt() { return planReceivingDateTime != null ? planReceivingDateTime : plannedShippingDateTime; }

    @JsonProperty("client")
    public EntityReference client() { return EntityReference.named(clientId, clientName); }

    @JsonProperty("contract")
    public EntityReference contract() { return EntityReference.named(contractId, contractName); }

    @JsonProperty("route")
    public EntityReference route() { return EntityReference.named(routeId, null); }
}
