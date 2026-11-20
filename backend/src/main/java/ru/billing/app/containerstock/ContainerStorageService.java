package ru.billing.app.containerstock;

import java.util.UUID;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Writes primary stock facts first, then appends their audit record in the same transaction. */
@Service
public class ContainerStorageService {
    private final JdbcTemplate jdbc;
    public ContainerStorageService(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    @Transactional(propagation=Propagation.MANDATORY)
    public UUID apply(UUID container, UUID previousClient, UUID nextClient, String previousStatus, String nextStatus,
            UUID order, String type, OffsetDateTime effectiveAt) {
        var instant=effectiveAt==null?jdbc.queryForObject("select billing_now()",OffsetDateTime.class):effectiveAt;
        var recorded=jdbc.queryForObject("select next_stock_recorded_at(?)",LocalDateTime.class,container);
        UUID audit=UUID.randomUUID();
        var period=jdbc.queryForObject("select apply_container_operation(?,?,?,?,?,?,?,?,?,?)",UUID.class,
            container,previousClient,nextClient,previousStatus,nextStatus,order,type,instant,recorded,audit);
        jdbc.update("insert into container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at,created_at,storage_period_id) values(?,?,?,?,?,?,?,?,?,?,?)",
            audit,container,previousClient,nextClient,previousStatus,nextStatus,order,type,instant,recorded,period);
        return period;
    }
}
