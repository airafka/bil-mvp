package ru.billing.app.route;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.OffsetDateTime;
import java.util.UUID;
import ru.billing.app.order.TransportType;

public record RouteSummary(UUID id, int code, RouteType routeType, OffsetDateTime departureAt,
        UUID terminalAreaId, String terminalAreaName, TransportType transportType,
        String carrier, String driverName, String vehicleNumber, String comment,
        String status, int orderCount, java.util.List<Integer> orderNumbers, UUID carrierId, UUID driverId, UUID vehicleId,
        String phoneNumber, String poaNumber, java.time.LocalDate poaValidTo, String insuranceNumber, Boolean withTrailer, String trailerNumber) {
    @JsonProperty("number")
    public int number() { return code; }

    @JsonProperty("dataTime")
    public OffsetDateTime dataTime() { return departureAt; }

    @JsonProperty("clientRelatedEntity")
    public EntityReference clientRelatedEntity() { return EntityReference.named(carrierId, carrier); }

    @JsonProperty("clientDriver")
    public EntityReference clientDriver() { return EntityReference.coded(driverId, driverName); }

    @JsonProperty("clientVehicle")
    public EntityReference clientVehicle() { return EntityReference.coded(vehicleId, vehicleNumber); }

    @JsonProperty("terminalArea")
    public EntityReference terminalArea() { return EntityReference.named(terminalAreaId, terminalAreaName); }
}
