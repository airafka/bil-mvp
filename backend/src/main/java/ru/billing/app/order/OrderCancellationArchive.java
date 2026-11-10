package ru.billing.app.order;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;

/** Immutable document composition, retained even after railway waybills become available again. */
public final class OrderCancellationArchive {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private OrderCancellationArchive() {}
    public static OrderDetails find(JdbcTemplate jdbc, String resource, UUID id) {
        var rows = jdbc.query("select details::text from order_cancellation where resource=? and order_id=?",
                (rs,n) -> rs.getString(1), resource,id);
        return rows.isEmpty() ? null : JSON.readValue(rows.getFirst(), OrderDetails.class);
    }
    public static void save(JdbcTemplate jdbc, String resource, UUID id, String reason, OrderDetails details) {
        jdbc.update("""
            insert into order_cancellation(order_id,resource,previous_status,reason,details)
            values(?,?,?,?,jsonb_set(?::jsonb,'{status}','"CANCELLED"'::jsonb))
            """,id,resource,details.status(),reason,JSON.writeValueAsString(details));
    }
}
