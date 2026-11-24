package ru.billing.app.containerstock;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import ru.billing.app.containerstock.OwnershipOrderService.Create;
import ru.billing.app.containerstock.OwnershipOrderService.Header;
import ru.billing.app.containerstock.OwnershipOrderService.Link;
import ru.billing.app.containerstock.OwnershipOrderService.ServiceType;
import ru.billing.app.error.ApiException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class OwnershipOrderServiceTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final OwnershipOrderService service = new OwnershipOrderService(jdbc, mock(ContainerStockService.class));
    private final UUID orderId = UUID.randomUUID();
    private final UUID previousOwner = UUID.randomUUID();
    private final UUID nextOwner = UUID.randomUUID();
    private final LocalDate date = LocalDate.of(2026, 11, 24);

    private void withOrder(String status) {
        Header header = new Header(orderId, 12, nextOwner, "Б", "CHANGE_OWNER", null, status, null, 0,
                date, previousOwner, "А", null, false, null, null, null, false);
        when(jdbc.query(contains("for update"), ArgumentMatchers.<RowMapper<UUID>>any(), eq(orderId)))
                .thenReturn(List.of(orderId));
        when(jdbc.queryForObject(contains("from service_order_current"), ArgumentMatchers.<RowMapper<Header>>any(), eq(orderId)))
                .thenReturn(header);
        when(jdbc.query(contains("from service_order_current"), ArgumentMatchers.<RowMapper<Header>>any(), eq(orderId)))
                .thenReturn(List.of(header));
    }

    @Test
    void draftSelectionCanBeClearedButApprovalNeedsEquipment() {
        withOrder("DRAFT");
        UUID linkId = UUID.randomUUID();
        var existing = new Link(linkId, UUID.randomUUID(), UUID.randomUUID(), "КТК", "STANDARD_20",
                previousOwner, "А", "ON_TERMINAL", UUID.randomUUID(), null, "DRAFT", null);
        when(jdbc.query(contains("from service_order_container_current sc join container c"),
                ArgumentMatchers.<RowMapper<Link>>any(), eq(orderId)))
                .thenReturn(List.of(existing)).thenReturn(List.of());
        assertThat(service.select(orderId, List.of()).containers()).isEmpty();
        verify(jdbc).update("delete from service_order_container where id=?", linkId);
        assertThatExceptionOfType(ApiException.class).isThrownBy(() -> service.accept(orderId))
                .satisfies(error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(error.getCode()).isEqualTo("SERVICE_ORDER_CONTAINERS_REQUIRED");
                });
    }

    @Test
    void emptyDraftNeedsAnExplicitSourceOwner() {
        assertThatExceptionOfType(ApiException.class)
                .isThrownBy(() -> service.create(new Create(nextOwner, ServiceType.CHANGE_OWNER, null, List.of(), date, null)))
                .satisfies(error -> assertThat(error.getCode()).isEqualTo("SOURCE_CLIENT_REQUIRED"));
        verifyNoInteractions(jdbc);
    }

    @Test
    void editingAndRepeatedApprovalHaveSeparateErrors() {
        withOrder("DONE");
        assertThatExceptionOfType(ApiException.class).isThrownBy(() -> service.select(orderId, List.of()))
                .satisfies(error -> assertThat(error.getStatus()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThatExceptionOfType(ApiException.class).isThrownBy(() -> service.accept(orderId))
                .satisfies(error -> assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT));
    }
}
