package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;

import ru.billing.app.reference.PartySelection;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.UUID;
import java.time.LocalDateTime;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record CreateOrderRequest(
    @NotNull(message = "Клиент обязателен") @JsonAlias("client") @JsonDeserialize(converter = EntityReference.Id.class) UUID clientId,
    @NotNull(message = "Договор обязателен") @JsonAlias("contract") @JsonDeserialize(converter = EntityReference.Id.class) UUID contractId,
    @NotNull(message = "Площадка обязательна") @JsonAlias("terminalArea") @JsonDeserialize(converter = EntityReference.Id.class) UUID terminalAreaId,
    @NotNull(message = "Тип транспорта обязателен") TransportType transportType,
    List<@NotNull @Valid OrderContainerRequest> containers,
    List<@NotNull UUID> waybillIds,
    List<@NotNull @Valid ShippingOrderRailwayCarriageRequest> railwayCarriages,
    FillingType fillingType,
    List<@NotNull @Valid ContainerQuantityRequest> containerQuantities,
    @JsonAlias("route") @JsonDeserialize(converter = EntityReference.Id.class) UUID routeId,
    @JsonAlias("planReceivingDateTime") LocalDateTime arrivalAt,
    @Size(max = 255, message = "Грузоотправитель: не более 255 символов") String consignor,
    @JsonAlias("plannedShippingDateTime") LocalDateTime departureAt,
    @Size(max = 255, message = "Грузополучатель: не более 255 символов") @JsonProperty("consigneeName") String consignee,
    @JsonAlias("defaultContainerOwner") @JsonDeserialize(converter = EntityReference.Id.class) UUID defaultContainerOwnerId,
    @Size(max = 255) String authorizedRepresentative,
    @Size(max = 50) String phone,
    @jakarta.validation.constraints.Email(message = "Укажите корректный email") @Size(max = 254) String email,
    @Size(max = 4000) String comment,
    @Size(max = 255, message = "Номер транспортной накладной: не более 255 символов") @JsonAlias("waybill") String transportWaybillNumber,
    @Size(max = 10000) List<@NotNull @Valid ContainerOwner> containerOwners, @JsonAlias("defaultRailwayCarriageOwner") @JsonDeserialize(converter = EntityReference.Id.class) UUID defaultRailwayCarriageOwnerId,
    @Valid PartySelection shipper, @Valid @JsonProperty("consignee") PartySelection destination
) {
    public CreateOrderRequest(UUID clientId, UUID contractId, UUID terminalAreaId, TransportType transportType,
            List<OrderContainerRequest> containers, List<UUID> waybillIds, List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            FillingType fillingType, List<ContainerQuantityRequest> containerQuantities, UUID routeId, LocalDateTime arrivalAt,
            String consignor, LocalDateTime departureAt, String consignee, UUID defaultContainerOwnerId, String authorizedRepresentative,
            String phone, String email, String comment, String transportWaybillNumber, List<ContainerOwner> containerOwners, UUID defaultRailwayCarriageOwnerId) {
        this(clientId, contractId, terminalAreaId, transportType, containers, waybillIds, railwayCarriages, fillingType, containerQuantities,
                routeId, arrivalAt, consignor, departureAt, consignee, defaultContainerOwnerId, authorizedRepresentative, phone, email, comment,
                transportWaybillNumber, containerOwners, defaultRailwayCarriageOwnerId, null, null);
    }

    public record ContainerOwner(@NotNull UUID containerId, @NotNull UUID ownerClientId) {}
    public UUID effectiveDefaultContainerOwnerId() { return defaultContainerOwnerId; }
    public CreateOrderRequest withDefaultContainerOwner(UUID owner) {
        return new CreateOrderRequest(clientId,contractId,terminalAreaId,transportType,containers,waybillIds,railwayCarriages,
            fillingType,containerQuantities,routeId,arrivalAt,consignor,departureAt,consignee,owner,authorizedRepresentative,phone,email,comment,transportWaybillNumber,containerOwners,defaultRailwayCarriageOwnerId,shipper,destination);
    }
    public CreateOrderRequest(UUID clientId,UUID contractId,UUID terminalAreaId,TransportType transportType,
            List<OrderContainerRequest> containers,List<UUID> waybillIds,List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            FillingType fillingType,List<ContainerQuantityRequest> containerQuantities,
            UUID routeId,LocalDateTime arrivalAt,String consignor,LocalDateTime departureAt,String consignee) {
        this(clientId,contractId,terminalAreaId,transportType,containers,waybillIds,railwayCarriages,fillingType,containerQuantities,routeId,arrivalAt,consignor,departureAt,consignee,null);
    }
    public CreateOrderRequest(UUID clientId,UUID contractId,UUID terminalAreaId,TransportType transportType,
            List<OrderContainerRequest> containers,List<UUID> waybillIds,List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            FillingType fillingType,List<ContainerQuantityRequest> containerQuantities,
            UUID routeId,LocalDateTime arrivalAt,String consignor,LocalDateTime departureAt,String consignee,UUID defaultContainerOwnerId) {
        this(clientId,contractId,terminalAreaId,transportType,containers,waybillIds,railwayCarriages,fillingType,containerQuantities,routeId,arrivalAt,consignor,departureAt,consignee,defaultContainerOwnerId,null,null,null,null);
    }
    public CreateOrderRequest(UUID clientId, UUID contractId, UUID terminalAreaId, TransportType transportType,
            List<OrderContainerRequest> containers, List<UUID> waybillIds, List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            FillingType fillingType, List<ContainerQuantityRequest> containerQuantities,
            UUID routeId, LocalDateTime arrivalAt, String consignor, LocalDateTime departureAt, String consignee, UUID defaultContainerOwnerId,
            String authorizedRepresentative, String phone, String email, String comment) {
        this(clientId,contractId,terminalAreaId,transportType,containers,waybillIds,railwayCarriages,fillingType,containerQuantities,routeId,arrivalAt,consignor,departureAt,consignee,defaultContainerOwnerId,
            authorizedRepresentative,phone,email,comment,null);
    }
    public CreateOrderRequest(UUID clientId, UUID contractId, UUID terminalAreaId, TransportType transportType,
            List<OrderContainerRequest> containers, List<UUID> waybillIds, List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            FillingType fillingType, List<ContainerQuantityRequest> containerQuantities,
            UUID routeId, LocalDateTime arrivalAt, String consignor, LocalDateTime departureAt, String consignee, UUID defaultContainerOwnerId,
            String authorizedRepresentative, String phone, String email, String comment, String transportWaybillNumber) {
        this(clientId,contractId,terminalAreaId,transportType,containers,waybillIds,railwayCarriages,fillingType,containerQuantities,routeId,arrivalAt,consignor,departureAt,consignee,defaultContainerOwnerId,
            authorizedRepresentative,phone,email,comment,transportWaybillNumber,List.of(),null);
    }
    public CreateOrderRequest {
        containerOwners = containerOwners == null ? List.of() : List.copyOf(containerOwners);
        transportWaybillNumber = clean(transportWaybillNumber);
        authorizedRepresentative = clean(authorizedRepresentative);
        phone = clean(phone);
        email = clean(email);
        comment = clean(comment);
        consignor = consignor == null || consignor.isBlank() ? null : consignor.strip();
        consignee = consignee == null || consignee.isBlank() ? null : consignee.strip();
    }

    public CreateOrderRequest(UUID clientId, UUID contractId, UUID terminalAreaId, TransportType transportType,
            List<OrderContainerRequest> containers, List<UUID> waybillIds,
            List<ShippingOrderRailwayCarriageRequest> railwayCarriages, FillingType fillingType,
            List<ContainerQuantityRequest> containerQuantities, UUID routeId) {
        this(clientId, contractId, terminalAreaId, transportType, containers, waybillIds, railwayCarriages,
                fillingType, containerQuantities, routeId, null, null, null, null);
    }

    public CreateOrderRequest(UUID clientId, UUID contractId, UUID terminalAreaId, TransportType transportType,
            List<OrderContainerRequest> containers, List<UUID> waybillIds,
            List<ShippingOrderRailwayCarriageRequest> railwayCarriages, FillingType fillingType,
            List<ContainerQuantityRequest> containerQuantities) {
        this(clientId, contractId, terminalAreaId, transportType, containers, waybillIds, railwayCarriages,
                fillingType, containerQuantities, null);
    }
    private static String clean(String value) { return value == null || value.isBlank() ? null : value.strip(); }
}
