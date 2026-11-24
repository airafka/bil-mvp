package ru.billing.app.containerstock;
import java.util.UUID;
import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;
import static org.junit.jupiter.api.Assertions.assertThrows;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

class ContainerStockPolicyTest {
    private final UUID order=UUID.randomUUID();
    @Test void missingAndDepartedContainersCanBeReceived() {
        assertThat(ContainerStockPolicy.reservationConflict(true,null)).isNull();
        assertThat(ContainerStockPolicy.reservationConflict(true,"DEPARTED")).isNull();
    }
    @Test void receivingRejectsAllOccupiedStates() {
        for(String status:new String[]{"EXPECTED","ON_TERMINAL","RESERVED_OUT"})
            assertThat(ContainerStockPolicy.reservationConflict(true,status)).isNotBlank();
    }
    @Test void shippingRequiresFreePhysicalStock() {
        assertThat(ContainerStockPolicy.reservationConflict(false,"ON_TERMINAL")).isNull();
        for(String status:new String[]{null,"EXPECTED","RESERVED_OUT","DEPARTED"})
            assertThat(ContainerStockPolicy.reservationConflict(false,status)).isNotBlank();
    }
    @Test void receivingCancellationRequiresItsOwnReservationOrCompletedArrival() {
        assertThat(ContainerStockPolicy.canCancel(true,false,"EXPECTED",order,order)).isTrue();
        assertThat(ContainerStockPolicy.canCancel(true,true,"ON_TERMINAL",order,order)).isTrue();
        for(String status:new String[]{"EXPECTED","RESERVED_OUT","DEPARTED"})
            assertThat(ContainerStockPolicy.canCancel(true,true,status,order,order)).isFalse();
    }
    @Test void shippingCancellationRequiresItsOwnReservationOrDeparture() {
        assertThat(ContainerStockPolicy.canCancel(false,false,"RESERVED_OUT",order,order)).isTrue();
        assertThat(ContainerStockPolicy.canCancel(false,true,"DEPARTED",order,order)).isTrue();
        for(String status:new String[]{"EXPECTED","ON_TERMINAL","RESERVED_OUT"})
            assertThat(ContainerStockPolicy.canCancel(false,true,status,order,order)).isFalse();
    }
    @Test void laterOrdersCannotBeReversedByAnEarlierCancellation() {
        UUID later=UUID.randomUUID();
        assertThat(ContainerStockPolicy.canCancel(true,true,"ON_TERMINAL",later,order)).isFalse();
        assertThat(ContainerStockPolicy.canCancel(false,true,"DEPARTED",later,order)).isFalse();
        assertThat(ContainerStockPolicy.canCancel(false,false,"RESERVED_OUT",later,order)).isFalse();
        assertThat(ContainerStockPolicy.canCancel(true,false,"EXPECTED",later,order)).isFalse();
    }

    @ParameterizedTest
    @CsvSource({
        "true,EXPECTED,ReceivingAlreadyReserved,RECEIVING",
        "true,ON_TERMINAL,ReceivingAlreadyInRemains,RECEIVING",
        "true,RESERVED_OUT,ReceivingAlreadyInShipping,SHIPPING",
        "false,,ShippingMissingInRemains,NONE",
        "false,DEPARTED,ShippingMissingInRemains,NONE",
        "false,EXPECTED,ShippingNotReceived,RECEIVING",
        "false,RESERVED_OUT,ShippingAlreadyReserved,SHIPPING"
    })
    void reservationErrorsMatchSource(boolean receiving, String state, String key, ContainerStockPolicy.RelatedOrder document) {
        var problem = ContainerStockPolicy.reservationViolation(receiving, state);
        assertThat(problem.key("ContainerStatus")).isEqualTo("ContainerStatus." + key);
        assertThat(problem.relatedOrder()).isEqualTo(document);
    }

    @ParameterizedTest
    @CsvSource({
        "true,RESERVED_OUT,CancelReceivingInShipping,SHIPPING",
        "true,,CancelReceivingDeparted,SHIPPING",
        "true,DEPARTED,CancelReceivingDeparted,SHIPPING",
        "true,EXPECTED,CancelReceivingReservedLater,RECEIVING",
        "true,ON_TERMINAL,CancelReceivingReservedLater,RECEIVING",
        "false,EXPECTED,CancelShippingExpected,RECEIVING",
        "false,ON_TERMINAL,CancelShippingReceived,RECEIVING",
        "false,RESERVED_OUT,CancelShippingReservedLater,SHIPPING",
        "false,DEPARTED,CancelShippingReservedLater,SHIPPING",
        "false,,CancelShippingReservedLater,SHIPPING"
    })
    void completedCancellationErrorsUseTheBlockingOperation(boolean receiving, String state, String key,
                                                            ContainerStockPolicy.RelatedOrder document) {
        var problem = ContainerStockPolicy.completedCancellationViolation(receiving, state, UUID.randomUUID(), order);
        assertThat(problem.key("ContainerStatus")).isEqualTo("ContainerStatus." + key);
        assertThat(problem.relatedOrder()).isEqualTo(document);
    }

    @Test void groupsByCauseAndOrderSortsCodesAndOmitsMissingOrderNumber() {
        var conflicts = new StockViolations();
        conflicts.add("ContainerStatus.ShippingNotReceived", 11, "ZZZZ", "КТК ещё не принят (поставка №11)");
        conflicts.add("ContainerStatus.ShippingMissingInRemains", null, "TTTT", "КТК отсутствует в остатках");
        conflicts.add("ContainerStatus.ShippingNotReceived", 11, "AAAA", "КТК ещё не принят (поставка №11)");
        conflicts.add("ContainerStatus.ShippingNotReceived", 12, "BBBB", "КТК ещё не принят (поставка №12)");
        assertThat(conflicts.originalMessage()).isEqualTo("ContainerStatus.ShippingNotReceived: [11; AAAA, ZZZZ], "
                + "ContainerStatus.ShippingMissingInRemains: [; TTTT], ContainerStatus.ShippingNotReceived: [12; BBBB]");
        assertThat(conflicts.detail()).isEqualTo("AAAA, ZZZZ: КТК ещё не принят (поставка №11); "
                + "TTTT: КТК отсутствует в остатках; BBBB: КТК ещё не принят (поставка №12)");
    }

    @Test void reportsMissingAndConflictingReceivingOwnersBeforeTaskAmbiguity() {
        var container = UUID.randomUUID();
        var owner = UUID.randomUUID();
        var rows = List.of(
                row(container, owner, "AAAA"), row(UUID.randomUUID(), null, "BBBB"),
                row(container, UUID.randomUUID(), "AAAA"));
        var failure = assertThrows(ApiException.class,
                () -> ContainerTaskRows.validateReceivingOwners(rows));
        assertThat(failure.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(failure.getMessage()).contains("BBBB: Не заполнен собственник КТК", "AAAA: Для КТК указаны разные собственники");
        assertThat(failure.getSourceMessage()).isEqualTo("Не заполнен собственник КТК: [; BBBB], Для КТК указаны разные собственники: [; AAAA]");
        ContainerTaskRows.validateReceivingOwners(List.of(row(container, owner, "AAAA"), row(container, owner, "AAAA")));
    }

    private ContainerTaskRows.Row row(UUID container, UUID owner, String code) {
        return new ContainerTaskRows.Row(UUID.randomUUID(), container, owner, null, "receiving_order_container", code);
    }
}
