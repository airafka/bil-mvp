package ru.billing.app.containerstock;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import ru.billing.app.error.ApiException;

class RailwayCarriageStockTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final RailwayCarriageStock stock = new RailwayCarriageStock(jdbc);
    private final UUID order = UUID.randomUUID();

    @Test
    void cancellationReportsTheLaterShipmentAndAllItsReservedWagons() throws Exception {
        UUID shipment = UUID.randomUUID();
        var first = wagon("90000001", shipment);
        var second = wagon("70000001", shipment);
        returnWagons(List.of(first, second));

        assertThatThrownBy(() -> stock.checkCancellation(true, order, "COMPLETED"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(error.getSourceMessage()).isEqualTo(
                            "RailwayCarriageStatus.CancelReceivingInShipping: [713; 70000001, 90000001]");
                });
    }

    @Test
    void completionRequiresAnExistingReservationForEachWagonInTheWaybills() throws Exception {
        returnWagons(List.of(wagon("70000001", null)));
        assertThatThrownBy(() -> stock.complete(true, order))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getSourceMessage())
                        .isEqualTo("Railway carriage has no reservation for receiving: 70000001"));
    }

    private ResultSet wagon(String code, UUID shipment) throws Exception {
        var row = mock(ResultSet.class);
        when(row.getObject("id", UUID.class)).thenReturn(UUID.randomUUID());
        when(row.getString("code")).thenReturn(code);
        if (shipment != null) {
            when(row.getObject("shipping_order_id", UUID.class)).thenReturn(shipment);
            when(row.getObject("shipping_number", Integer.class)).thenReturn(713);
            when(row.getString("status")).thenReturn("RESERVED_OUT");
        }
        return row;
    }

    private void returnWagons(List<ResultSet> rows) {
        when(jdbc.query(anyString(), ArgumentMatchers.<RowMapper<Object>>any(), eq(order))).thenAnswer(call -> {
            RowMapper<?> mapper = call.getArgument(1);
            var wagons = new ArrayList<>();
            for (var row : rows) wagons.add(mapper.mapRow(row, wagons.size()));
            return wagons;
        });
    }
}
