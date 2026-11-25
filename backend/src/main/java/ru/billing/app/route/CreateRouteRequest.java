package ru.billing.app.route;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import jakarta.validation.constraints.NotNull;
import ru.billing.app.order.TransportType;

public record CreateRouteRequest(
        @NotNull RouteType routeType,
        @NotNull @JsonAlias("dataTime") OffsetDateTime departureAt,
        @NotNull @JsonAlias("terminalArea") @JsonDeserialize(converter = EntityReference.Id.class) UUID terminalAreaId,
        @NotNull TransportType transportType,
        @JsonAlias("clientRelatedEntity") @JsonDeserialize(converter = EntityReference.Id.class) UUID carrierId,
        @JsonAlias("clientDriver") @JsonDeserialize(converter = EntityReference.Id.class) UUID driverId,
        @JsonAlias("clientVehicle") @JsonDeserialize(converter = EntityReference.Id.class) UUID vehicleId,
        String comment,
        @NotNull List<UUID> orderIds
) {}
