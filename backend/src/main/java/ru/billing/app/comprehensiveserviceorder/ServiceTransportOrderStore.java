package ru.billing.app.comprehensiveserviceorder;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import ru.billing.app.order.TransportType;
import ru.billing.app.route.RouteType;

/** Compact transport context for all rows of a service, without loading each order and route. */
@Repository
public class ServiceTransportOrderStore {
    private final JdbcTemplate jdbc;

    public ServiceTransportOrderStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<TransportOrder> findByServiceId(UUID serviceId) {
        return jdbc.query("""
                select o.id, o.order_status, o.terminal_area_catalog_id, o.transport_type,
                       'RECEIVING' as kind, r.id as route_id, r.number as route_code
                  from receiving_order o left join route r on r.id = o.route_id
                 where o.comprehensive_service_order_id = ?
                union all
                select o.id, o.order_status, o.terminal_area_catalog_id, o.transport_type,
                       'SHIPPING' as kind, r.id as route_id, r.number as route_code
                  from shipping_order o left join route r on r.id = o.route_id
                 where o.comprehensive_service_order_id = ?
                order by kind, id
                """, (rs, row) -> {
                    UUID routeId = rs.getObject("route_id", UUID.class);
                    return new TransportOrder(rs.getObject("id", UUID.class),
                            RouteType.valueOf(rs.getString("kind")), rs.getString("order_status"),
                            rs.getObject("terminal_area_catalog_id", UUID.class),
                            TransportType.valueOf(rs.getString("transport_type")),
                            routeId == null ? null : new RouteReference(routeId, rs.getInt("route_code")));
                }, serviceId, serviceId);
    }

    public record TransportOrder(UUID id, RouteType kind, String status, UUID terminalAreaId,
                                 TransportType transportType, RouteReference route) {}
    public record RouteReference(UUID id, int code) {}
}
