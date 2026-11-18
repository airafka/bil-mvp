package ru.billing.app.order;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

final class OrderRowMapper {
    private OrderRowMapper() {}

    static OrderSummary summary(ResultSet row, FillingType fillingType) throws SQLException {
        return new OrderSummary(
                row.getObject("id", UUID.class),
                row.getInt("code"),
                row.getObject("client_id", UUID.class),
                row.getString("client_name"),
                terminalArea(row),
                transportType(row.getString("transport_type")),
                fillingType,
                row.getString("status"),
                row.getObject("contract_id", UUID.class),
                row.getString("contract_name"),
                row.getObject("comprehensive_service_order_id", UUID.class),
                row.getObject("planned_at", LocalDateTime.class),
                row.getObject("route_id", UUID.class),
                row.getObject("route_number", Integer.class),
                row.getObject("service_number", Integer.class),
                row.getString("comment")
        );
    }

    static OrderContainerDetails container(ResultSet row) throws SQLException {
        UUID etsngCodeId = row.getObject("etsng_code_id", UUID.class);
        OrderCargoDetails cargo = etsngCodeId == null ? null : new OrderCargoDetails(
                etsngCodeId, row.getString("etsng_code_name"), row.getBigDecimal("wight_net")
        );
        return new OrderContainerDetails(
                row.getObject("container_id", UUID.class),
                row.getString("container_name"),
                row.getBoolean("empty"),
                cargo,
                row.getObject("owner_container_id", UUID.class), row.getString("owner_container_name"),
                row.getString("seal_numbers"),
                row.getObject("seal_type_id", UUID.class), row.getString("seal_type_name"),
                row.getObject("danger_class_id", UUID.class), row.getString("danger_class_name"),
                cargo == null ? List.of() : List.of(cargo), row.getString("container_status")
        );
    }

    static TerminalAreaDetails terminalArea(ResultSet row) throws SQLException {
        return new TerminalAreaDetails(
                row.getObject("area_id", UUID.class),
                row.getString("area_code"),
                row.getString("area_name")
        );
    }

    static TransportType transportType(String value) {
        return value == null ? null : TransportType.valueOf(value);
    }
}
