package ru.billing.app.route;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.annotation.JsonAlias;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.List;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
public record UpdateRouteRequest(@NotNull @JsonAlias("dataTime") OffsetDateTime departureAt,@JsonAlias("clientRelatedEntity") @JsonDeserialize(converter = EntityReference.Id.class) UUID carrierId,@JsonAlias("clientDriver") @JsonDeserialize(converter = EntityReference.Id.class) UUID driverId,@JsonAlias("clientVehicle") @JsonDeserialize(converter = EntityReference.Id.class) UUID vehicleId,
 @Size(max=200) String comment,@NotNull List<UUID> orderIds) {}
