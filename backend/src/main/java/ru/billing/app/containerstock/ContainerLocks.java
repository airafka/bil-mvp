package ru.billing.app.containerstock;

import java.util.Collection;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import ru.billing.app.error.ApiException;

/** One calendar/container lock order for stock, owner refresh and draft snapshots. */
public final class ContainerLocks {
    private ContainerLocks() {}

    public static List<UUID> lock(JdbcTemplate jdbc, Collection<UUID> containerIds) {
        jdbc.queryForObject("select billing_today()", java.time.LocalDate.class);
        var ids = containerIds.stream().distinct().toList();
        if (ids.isEmpty()) return List.of();
        // PostgreSQL UUID order differs from UUID.compareTo for the sign bit.
        // Let the database order every complete batch, just like the daily refresh.
        String marks = String.join(",", Collections.nCopies(ids.size(), "?"));
        var locked = jdbc.query("select id from container where id in (" + marks + ") order by id for update",
                (rs, n) -> rs.getObject(1, UUID.class), ids.toArray());
        if (locked.size() != ids.size()) throw new ApiException(HttpStatus.CONFLICT,
                "CONTAINER_NOT_FOUND", "КТК не найден");
        return locked;
    }

    public static void lockCurrentOwners(JdbcTemplate jdbc, Collection<UUID> containerIds) {
        refreshLockedOwners(jdbc, lock(jdbc, containerIds));
    }

    /** Refresh the complete already-locked batch in one database call. */
    public static void refreshLockedOwners(JdbcTemplate jdbc, Collection<UUID> lockedIds) {
        if (lockedIds.isEmpty()) return;
        String marks = String.join(",", Collections.nCopies(lockedIds.size(), "?"));
        jdbc.queryForObject("select refresh_container_owner_clients(array[" + marks + "]::uuid[])",
                Integer.class, lockedIds.toArray());
    }

    /** Acquire the union before a route/section starts processing its individual documents. */
    public static void lockOrders(JdbcTemplate jdbc, Collection<UUID> receiving, Collection<UUID> shipping) {
        var containers = new ArrayList<UUID>();
        if (!receiving.isEmpty()) {
            String marks = String.join(",", Collections.nCopies(receiving.size(), "?"));
            containers.addAll(jdbc.query("select container_id from receiving_order_container where receiving_order_id in (" + marks + ")",
                    (rs,n) -> rs.getObject(1,UUID.class), receiving.toArray()));
            containers.addAll(jdbc.query("select wc.container_id from waybill_container wc join waybill_railway_carriage wr on wr.id=wc.waybill_railway_carriage_id "
                    + "join waybill w on w.id=wr.waybill_id where w.receiving_order_id in (" + marks + ")",
                    (rs,n) -> rs.getObject(1,UUID.class), receiving.toArray()));
        }
        if (!shipping.isEmpty()) {
            String marks = String.join(",", Collections.nCopies(shipping.size(), "?"));
            containers.addAll(jdbc.query("select container_id from shipping_order_container where shipping_order_id in (" + marks + ")",
                    (rs,n) -> rs.getObject(1,UUID.class), shipping.toArray()));
        }
        lock(jdbc, containers);
    }
}
