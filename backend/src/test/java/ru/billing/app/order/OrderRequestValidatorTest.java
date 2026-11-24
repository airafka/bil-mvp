package ru.billing.app.order;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.billing.app.error.ApiException;

class OrderRequestValidatorTest {

    private static final UUID CLIENT_ID = UUID.randomUUID();
    private static final UUID TERMINAL_AREA_ID = UUID.randomUUID();
    private static final UUID CONTAINER_ONE = UUID.randomUUID();
    private static final UUID CONTAINER_TWO = UUID.randomUUID();
    private static final UUID ETSNG_ID = UUID.randomUUID();
    private static final UUID WAYBILL_ONE = UUID.randomUUID();

    private final OrderRequestValidator validator = new OrderRequestValidator();

    @Test
    void acceptsContainerAreaWithVehicle() {
        assertThatCode(() -> validator.validate(request(TransportType.VEHICLE, loaded(CONTAINER_ONE))))
                .doesNotThrowAnyException();
    }

    @Test
    void acceptsContainerAreaWithRailway() {
        assertThatCode(() -> validator.validate(railwayReceiving(CLIENT_ID))).doesNotThrowAnyException();
    }

    @Test
    void requiresRailwayOwnerEvenWhenReceivingClientIsKnown() {
        assertError(railwayReceiving(null), "DEFAULT_RAILWAY_CARRIAGE_OWNER_REQUIRED");
    }

    private CreateOrderRequest railwayReceiving(UUID wagonOwner) {
        return new CreateOrderRequest(CLIENT_ID, UUID.randomUUID(), TERMINAL_AREA_ID, TransportType.RAILWAY,
                List.of(), List.of(WAYBILL_ONE), List.of(), FillingType.ALL, List.of(),
                null, null, null, null, null, CLIENT_ID, null, null, null, null, null, List.of(), wagonOwner);
    }

    @Test
    void rejectsMissingTerminalArea() {
        assertError(new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                null,
                TransportType.VEHICLE,
                List.of(empty(CONTAINER_ONE)),
                List.of(),
                List.of(),
                FillingType.ALL,
                List.of()
        ), "TERMINAL_AREA_REQUIRED");
    }

    @Test
    void rejectsMissingTransportType() {
        assertError(new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                null,
                List.of(empty(CONTAINER_ONE)),
                List.of(),
                List.of(),
                FillingType.ALL,
                List.of()
        ), "TRANSPORT_TYPE_REQUIRED");
    }

    @Test
    void acceptsMixedContainers() {
        assertThatCode(() -> validator.validate(vehicleRequest(
                List.of(empty(CONTAINER_ONE), loaded(CONTAINER_TWO)), List.of(), List.of()
        ))).doesNotThrowAnyException();
    }

    @Test
    void rejectsEmptyContainerList() {
        assertError(vehicleRequest(List.of(), List.of(), List.of()), "EMPTY_CONTAINER_LIST");
    }

    @Test
    void rejectsDuplicateContainer() {
        assertError(vehicleRequest(
                List.of(empty(CONTAINER_ONE), empty(CONTAINER_ONE)), List.of(), List.of()
        ), "DUPLICATE_CONTAINER");
    }

    @Test
    void rejectsCargoForEmptyContainer() {
        assertError(request(TransportType.VEHICLE, new OrderContainerRequest(
                CONTAINER_ONE, true, new CargoRequest(ETSNG_ID, BigDecimal.ONE)
        )), "CARGO_FOR_EMPTY_CONTAINER");
    }

    @Test
    void rejectsMissingCargoForLoadedContainer() {
        assertError(request(
                TransportType.VEHICLE,
                new OrderContainerRequest(CONTAINER_ONE, false, null)
        ), "CARGO_REQUIRED");
    }

    @Test
    void rejectsNonPositiveWeight() {
        assertError(request(TransportType.VEHICLE, new OrderContainerRequest(
                CONTAINER_ONE, false, new CargoRequest(ETSNG_ID, BigDecimal.ZERO)
        )), "INVALID_WEIGHT");
    }

    @Test
    void rejectsWaybillsForVehicle() {
        assertError(vehicleRequest(
                List.of(empty(CONTAINER_ONE)), List.of(WAYBILL_ONE), List.of()
        ), "WAYBILLS_NOT_ALLOWED_FOR_VEHICLE");
    }

    @Test
    void rejectsContainersForRailway() {
        assertError(new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.RAILWAY,
                List.of(empty(CONTAINER_ONE)),
                List.of(WAYBILL_ONE),
                List.of(),
                FillingType.ALL,
                List.of()
        ), "CONTAINERS_NOT_ALLOWED_FOR_RAILWAY");
    }

    @Test
    void rejectsEmptyAndDuplicateRailwayWaybills() {
        assertError(new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.RAILWAY,
                List.of(),
                List.of(),
                List.of(),
                FillingType.ALL,
                List.of()
        ), "EMPTY_WAYBILL_LIST");
        assertError(new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.RAILWAY,
                List.of(),
                List.of(WAYBILL_ONE, WAYBILL_ONE),
                List.of(),
                FillingType.ALL,
                List.of()
        ), "DUPLICATE_WAYBILL");
    }

    @Test
    void acceptsRailwayShipping() {
        CreateOrderRequest request = new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.RAILWAY,
                List.of(),
                List.of(),
                List.of(new ShippingOrderRailwayCarriageRequest(
                        UUID.randomUUID(),
                        List.of(empty(CONTAINER_ONE))
                )),
                FillingType.ALL,
                List.of()
        );
        assertThatCode(() -> validator.validateShipping(request)).doesNotThrowAnyException();
    }

    @Test
    void rejectsInvalidRailwayShippingComposition() {
        UUID carriage = UUID.randomUUID();
        assertShippingError(List.of(), List.of(), "RAILWAY_CARRIAGES_REQUIRED");
        assertShippingError(List.of(new ShippingOrderRailwayCarriageRequest(carriage, List.of())), List.of(), "EMPTY_RAILWAY_CARRIAGE");
        assertShippingError(List.of(
                new ShippingOrderRailwayCarriageRequest(carriage, List.of(empty(CONTAINER_ONE))),
                new ShippingOrderRailwayCarriageRequest(carriage, List.of(empty(CONTAINER_TWO)))
        ), List.of(), "DUPLICATE_RAILWAY_CARRIAGE");
        assertShippingError(List.of(
                new ShippingOrderRailwayCarriageRequest(carriage, List.of(empty(CONTAINER_ONE))),
                new ShippingOrderRailwayCarriageRequest(UUID.randomUUID(), List.of(empty(CONTAINER_ONE)))
        ), List.of(), "DUPLICATE_CONTAINER");
        assertShippingError(
                List.of(new ShippingOrderRailwayCarriageRequest(carriage, List.of(empty(CONTAINER_ONE)))),
                List.of(empty(CONTAINER_TWO)),
                "CONTAINERS_NOT_ALLOWED_FOR_RAILWAY"
        );
    }















    private CreateOrderRequest request(TransportType transportType, OrderContainerRequest container) {
        if (transportType == TransportType.VEHICLE) {
            return vehicleRequest(List.of(container), List.of(), List.of());
        }
        return new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                transportType,
                List.of(container),
                List.of(),
                List.of(),
                FillingType.ALL,
                List.of()
        );
    }

    private CreateOrderRequest vehicleRequest(
            List<OrderContainerRequest> containers,
            List<UUID> waybillIds,
            List<ShippingOrderRailwayCarriageRequest> railwayCarriages
    ) {
        return new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.VEHICLE,
                containers,
                waybillIds,
                railwayCarriages,
                FillingType.ALL,
                List.of()
        );
    }

    private CreateOrderRequest unnumberedVehicleRequest(
            List<OrderContainerRequest> containers,
            List<ContainerQuantityRequest> containerQuantities
    ) {
        return new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.VEHICLE,
                containers,
                List.of(),
                List.of(),
                FillingType.NONE_CONTAINER,
                containerQuantities
        );
    }

    private void assertShippingError(
            List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            List<OrderContainerRequest> containers,
            String expectedCode
    ) {
        CreateOrderRequest request = new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.RAILWAY,
                containers,
                List.of(),
                railwayCarriages,
                FillingType.ALL,
                List.of()
        );
        assertThatThrownBy(() -> validator.validateShipping(request))
                .isInstanceOf(ApiException.class)
                .extracting(exception -> ((ApiException) exception).getCode())
                .isEqualTo(expectedCode);
    }

    private void assertShippingError(CreateOrderRequest request, String expectedCode) {
        assertThatThrownBy(() -> validator.validateShipping(request))
                .isInstanceOf(ApiException.class)
                .extracting(exception -> ((ApiException) exception).getCode())
                .isEqualTo(expectedCode);
    }

    private CreateOrderRequest shippingRequest(
            FillingType fillingType,
            List<ShippingOrderRailwayCarriageRequest> railwayCarriages,
            List<OrderContainerRequest> containers,
            List<ContainerQuantityRequest> containerQuantities
    ) {
        return new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.RAILWAY,
                containers,
                List.of(),
                railwayCarriages,
                fillingType,
                containerQuantities
        );
    }

    private OrderContainerRequest loaded(UUID containerId) {
        return new OrderContainerRequest(
                containerId,
                false,
                new CargoRequest(ETSNG_ID, new BigDecimal("24500.000"))
        );
    }

    private OrderContainerRequest empty(UUID containerId) {
        return new OrderContainerRequest(containerId, true, null);
    }

    private void assertError(CreateOrderRequest request, String expectedCode) {
        assertThatThrownBy(() -> validator.validate(request))
                .isInstanceOf(ApiException.class)
                .extracting(exception -> ((ApiException) exception).getCode())
                .isEqualTo(expectedCode);
    }

    @Test
    void acceptsUnnumberedVehicleShipping() {
        CreateOrderRequest request = unnumberedVehicleRequest(
                List.of(),
                List.of(new ContainerQuantityRequest(1, ContainerType.STANDARD_40, true, List.of()))
        );

        assertThatCode(() -> validator.validateShipping(request)).doesNotThrowAnyException();
    }

    @Test
    void rejectsNumberedContainerAndInvalidQuantityForUnnumberedVehicleShipping() {
        assertShippingError(unnumberedVehicleRequest(
                List.of(empty(CONTAINER_ONE)),
                List.of(new ContainerQuantityRequest(1, ContainerType.STANDARD_40, true, List.of()))
        ), "NUMBERED_CONTAINERS_NOT_ALLOWED");
        assertShippingError(unnumberedVehicleRequest(
                List.of(),
                List.of(new ContainerQuantityRequest(0, ContainerType.STANDARD_40, true, List.of()))
        ), "INVALID_QUANTITY");
        assertShippingError(unnumberedVehicleRequest(List.of(), List.of()), "SINGLE_CONTAINER_QUANTITY_REQUIRED");
    }

    @Test
    void rejectsLoadedCargoAndMissingTypeForUnnumberedVehicleShipping() {
        assertShippingError(unnumberedVehicleRequest(List.of(),List.of(new ContainerQuantityRequest(2,ContainerType.STANDARD_40,true,List.of()))),"INVALID_QUANTITY");
        assertShippingError(unnumberedVehicleRequest(
                List.of(),
                List.of(new ContainerQuantityRequest(1, ContainerType.STANDARD_40, false, List.of()))
        ), "NONE_CONTAINER_CONTAINER_MUST_BE_EMPTY");
        assertShippingError(unnumberedVehicleRequest(
                List.of(),
                List.of(new ContainerQuantityRequest(
                        1,
                        ContainerType.STANDARD_40,
                        true,
                        List.of(new CargoRequest(ETSNG_ID, BigDecimal.ONE))
                ))
        ), "CARGO_NOT_ALLOWED_FOR_NONE_CONTAINER");
        assertShippingError(unnumberedVehicleRequest(
                List.of(),
                List.of(new ContainerQuantityRequest(1, null, true, List.of()))
        ), "CONTAINER_TYPE_REQUIRED");
    }

    @Test
    void rejectsUnnumberedVehicleModeForReceivingAndRailway() {
        CreateOrderRequest request = new CreateOrderRequest(
                CLIENT_ID,
                UUID.randomUUID(),
                TERMINAL_AREA_ID,
                TransportType.VEHICLE,
                List.of(),
                List.of(),
                List.of(),
                FillingType.NONE_CONTAINER,
                List.of(new ContainerQuantityRequest(1, ContainerType.STANDARD_40, true, List.of()))
        );
        assertThatThrownBy(() -> validator.validate(request))
                .isInstanceOf(ApiException.class)
                .extracting(exception -> ((ApiException) exception).getCode())
                .isEqualTo("INVALID_VEHICLE_FILLING_TYPE");

        assertShippingError(shippingRequest(
                FillingType.NONE_CONTAINER,
                List.of(),
                List.of(),
                List.of(new ContainerQuantityRequest(1, ContainerType.STANDARD_40, true, List.of()))
        ), "NONE_CONTAINER_ONLY_FOR_VEHICLE_SHIPPING");
    }
}
