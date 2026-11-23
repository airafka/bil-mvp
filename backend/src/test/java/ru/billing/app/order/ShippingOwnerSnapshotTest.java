package ru.billing.app.order;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.LocalDate;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/** Guard the batch boundary: all KTK locks must precede the first owner snapshot. */
class ShippingOwnerSnapshotTest {
    private final UUID low = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private final UUID high = UUID.fromString("80000000-0000-0000-0000-000000000001");

    @SuppressWarnings("unchecked")
    private JdbcTemplate guardedJdbc(Set<UUID> expected) {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        Set<UUID> locked = new HashSet<>();
        boolean[] calendar = {false};
        when(jdbc.queryForObject("select billing_today()", LocalDate.class)).thenAnswer(call -> {
            calendar[0] = true;
            return LocalDate.of(2026, 11, 20);
        });
        when(jdbc.query(anyString(), any(RowMapper.class), any(Object[].class))).thenAnswer(call -> {
            String sql = call.getArgument(0);
            if(sql.contains("from container where id in (")) {
                assertThat(calendar[0]).as("calendar before container locks").isTrue();
                assertThat(sql).contains("order by id for update");
                Object[] args = call.getArguments();
                for(int i=2;i<args.length;i++) locked.add((UUID)args[i]);
                assertThat(locked).containsExactlyInAnyOrderElementsOf(expected);
                return locked.stream().sorted(java.util.Comparator.comparing(UUID::toString)).toList();
            }
            if(sql.contains("select order_status as status")) return List.of(List.of("DRAFT", "VEHICLE"));
            return List.of();
        });
        when(jdbc.queryForObject(anyString(), eq(Integer.class), any(Object[].class))).thenReturn(1);
        when(jdbc.queryForObject(contains("select client_id from container_owner_current"), eq(UUID.class), any(UUID.class)))
                .thenAnswer(call -> {
                    assertThat(locked).as("whole batch locked before reading an owner")
                            .containsExactlyInAnyOrderElementsOf(expected);
                    return UUID.randomUUID();
                });
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(1);
        return jdbc;
    }

    private OrderContainerRequest container(UUID id) { return new OrderContainerRequest(id, true, null); }

    @Test
    void autoCreationLocksBothContainersWhenInactiveRailwayCompositionIsNull() {
        JdbcTemplate jdbc = guardedJdbc(Set.of(low, high));
        var request = new CreateOrderRequest(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                TransportType.VEHICLE, List.of(container(high), container(low)), List.of(), null,
                FillingType.ALL, List.of());
        new ShippingOrderStore(jdbc).create(request);
        verify(jdbc, times(2)).queryForObject(contains("select client_id from container_owner_current"), eq(UUID.class), any(UUID.class));
    }

    @Test
    void railCreationLocksTheUnionAcrossCarriagesBeforeTheFirstSnapshot() {
        JdbcTemplate jdbc = guardedJdbc(Set.of(low, high));
        var request = new CreateOrderRequest(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                TransportType.RAILWAY, null, List.of(), List.of(
                    new ShippingOrderRailwayCarriageRequest(UUID.randomUUID(), List.of(container(high))),
                    new ShippingOrderRailwayCarriageRequest(UUID.randomUUID(), List.of(container(low)))),
                FillingType.ALL, List.of());
        new ShippingOrderStore(jdbc).create(request);
        verify(jdbc, times(2)).queryForObject(contains("select client_id from container_owner_current"), eq(UUID.class), any(UUID.class));
    }

    @Test
    void patchLocksExistingRowsAndAdditionsTogether() {
        JdbcTemplate jdbc = guardedJdbc(Set.of(low, high));
        var request = new UpdateOrderContainersRequest(
                List.of(new UpdateOrderContainersRequest.Attributes(high,null,null,null,null)), null,
                List.of(new UpdateOrderContainersRequest.Addition(container(low), null)));
        new ShippingOrderStore(jdbc).updateContainerAttributes(UUID.randomUUID(), request);
        verify(jdbc).queryForObject(contains("select client_id from container_owner_current"), eq(UUID.class), eq(high));
    }
}
