package ru.billing.app.containerstock;
import java.util.UUID;
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
}
