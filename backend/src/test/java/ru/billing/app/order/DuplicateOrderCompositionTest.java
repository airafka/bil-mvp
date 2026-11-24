package ru.billing.app.order;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import ru.billing.app.error.ApiException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

class DuplicateOrderCompositionTest {
    private final OrderRequestValidator validator = new OrderRequestValidator();
    private final OrderContainerRequest unit = new OrderContainerRequest(UUID.randomUUID(), true, null);

    @Test void duplicateVehicleContainersUseTheDocumentSpecificSourceCode() {
        var request = request(TransportType.VEHICLE, List.of(unit, unit), List.of());
        assertDuplicate(() -> validator.validate(request), "DUPLICATE_CONTAINER", "ReceivingOrderContainer.AlreadyExists");
        assertDuplicate(() -> validator.validateShipping(request), "DUPLICATE_CONTAINER", "ShippingOrderContainer.AlreadyExists");
    }

    @Test void duplicateNumberedRailContainersAreCheckedAcrossWagons() {
        var one = new ShippingOrderRailwayCarriageRequest(UUID.randomUUID(), List.of(unit));
        var two = new ShippingOrderRailwayCarriageRequest(UUID.randomUUID(), List.of(unit));
        var request = request(TransportType.RAILWAY, List.of(), List.of(one, two));
        assertDuplicate(() -> validator.validateShipping(request), "DUPLICATE_CONTAINER", "ShippingOrderContainer.AlreadyExists");
    }

    @Test void duplicateWagonIsReportedBeforeReadingItsContainers() {
        var wagon = new ShippingOrderRailwayCarriageRequest(UUID.randomUUID(), List.of(unit));
        var request = request(TransportType.RAILWAY, List.of(), List.of(wagon, wagon));
        assertDuplicate(() -> validator.validateShipping(request), "DUPLICATE_RAILWAY_CARRIAGE", "ShippingOrderRailwayCarriage.AlreadyExists");
    }

    private CreateOrderRequest request(TransportType transport, List<OrderContainerRequest> containers,
                                       List<ShippingOrderRailwayCarriageRequest> wagons) {
        return new CreateOrderRequest(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), transport,
                containers, List.of(), wagons, FillingType.ALL, List.of());
    }

    private void assertDuplicate(Runnable check, String localCode, String sourceCode) {
        var failure = assertThrows(ApiException.class, check::run);
        assertThat(failure.getStatus()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(failure.getCode()).isEqualTo(localCode);
        assertThat(failure.getSourceCode()).isEqualTo(sourceCode);
        assertThat(failure.getSourceMessage()).isEqualTo(sourceCode);
    }
}
