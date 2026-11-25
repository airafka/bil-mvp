package ru.billing.app.containerstock;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import ru.billing.app.error.ApiException;

@Service
public class RailwayCarriageStock {
    private final JdbcTemplate jdbc;
    public RailwayCarriageStock(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    private record Wagon(UUID id, UUID owner, String code, String status, UUID receivingOrder,
            UUID shippingOrder, Integer receivingNumber, Integer shippingNumber) {
        void addViolation(StockViolations violations, ContainerStockPolicy.Violation violation) {
            if (violation == null) return;
            Integer number = switch (violation.relatedOrder()) {
                case RECEIVING -> receivingNumber;
                case SHIPPING -> shippingNumber;
                case NONE -> null;
            };
            String detail = violation.description("Вагон");
            if (number != null) detail += " (" + (violation.relatedOrder() == ContainerStockPolicy.RelatedOrder.RECEIVING
                    ? "поставка" : "вывоз") + " №" + number + ")";
            violations.add(violation.key("RailwayCarriageStatus"), number, code, detail);
        }
    }

    private static final String WAGON = """
            select c.id, o.client_owner_id, c.code, o.status, o.receiving_order_id, o.shipping_order_id,
                   r.number as receiving_number, s.number as shipping_number
            from railway_carriage c
            left join railway_carriage_owner o on o.railway_carriage_id=c.id
            left join receiving_order r on r.id=o.receiving_order_id
            left join shipping_order s on s.id=o.shipping_order_id
            """;

    private List<Wagon> wagons(String where, UUID id) {
        // Read current stock after acquiring the catalog locks, including wagons without history.
        jdbc.queryForList("select c.id from railway_carriage c where " + where + " order by c.id for update", UUID.class, id);
        return jdbc.query(WAGON + " where " + where + " order by c.id", (rs, n) -> new Wagon(
                rs.getObject("id", UUID.class), rs.getObject("client_owner_id", UUID.class), rs.getString("code"),
                rs.getString("status"), rs.getObject("receiving_order_id", UUID.class), rs.getObject("shipping_order_id", UUID.class),
                rs.getObject("receiving_number", Integer.class), rs.getObject("shipping_number", Integer.class)), id);
    }
    private static final String RECEIPTS = """
            c.id in (select wr.railway_carriage_id from waybill_railway_carriage wr
            join waybill w on w.id=wr.waybill_id where w.receiving_order_id=?)
            """;
    private static final String SHIPMENTS = "c.id in (select railway_carriage_id from shipping_order_railway_carriage where shipping_order_id=?)";

    public void confirm(boolean receiving, UUID id) {
        if (!receiving && "NONE_CONTAINER".equals(jdbc.queryForObject(
                "select filling_type from shipping_order where id=?", String.class, id))) {
            checkAutoPlan(id);
            return;
        }
        var wagons = wagons(receiving ? RECEIPTS : SHIPMENTS, id);
        if (wagons.isEmpty()) {
            checkEmptyComposition(receiving, id);
            return;
        }
        var violations = new StockViolations();
        var owners = new LinkedHashMap<UUID, UUID>();
        UUID defaultOwner = receiving ? jdbc.queryForObject(
                "select default_railway_carriage_owner_id from receiving_order where id=?", UUID.class, id) : null;
        for (var wagon : wagons) {
            owners.put(wagon.id(), receiving ? receivingOwner(wagon, id, defaultOwner) : wagon.owner());
            wagon.addViolation(violations, ContainerStockPolicy.reservationViolation(receiving, wagon.status()));
        }
        rejectStockViolations(violations);
        for (var wagon : wagons) {
            UUID owner = owners.get(wagon.id());
            if (receiving) {
                jdbc.update("""
                        update waybill_railway_carriage wr set owner_railway_carriage_id=? from waybill w
                        where w.id=wr.waybill_id and w.receiving_order_id=? and wr.railway_carriage_id=?
                          and wr.owner_railway_carriage_id is null
                        """, owner, id, wagon.id());
                record(wagon.id(), owner, id, null, "EXPECTED");
            } else {
                record(wagon.id(), owner, null, id, "RESERVED_OUT");
                jdbc.update("update shipping_order_railway_carriage set owner_railway_carriage_id=? where shipping_order_id=? and railway_carriage_id=?",
                        owner, id, wagon.id());
            }
        }
    }

    private UUID receivingOwner(Wagon wagon, UUID order, UUID defaultOwner) {
        var explicitOwners = jdbc.queryForList("""
                select distinct wr.owner_railway_carriage_id from waybill_railway_carriage wr
                join waybill w on w.id=wr.waybill_id where w.receiving_order_id=? and wr.railway_carriage_id=?
                  and wr.owner_railway_carriage_id is not null
                """, UUID.class, order, wagon.id());
        if (explicitOwners.size() > 1) throw referenceError("В накладных указаны разные собственники вагона " + wagon.code(),
                "Conflicting declared owners for railway carriage: " + wagon.code());
        if (!explicitOwners.isEmpty()) return explicitOwners.getFirst();
        if (defaultOwner == null) throw referenceError("Укажите собственника вагона " + wagon.code(),
                "Missing railway carriage owner: " + wagon.code());
        return defaultOwner;
    }

    private void checkEmptyComposition(boolean receiving, UUID order) {
        if (!receiving && Boolean.TRUE.equals(jdbc.queryForObject(
                "select transport_type='RAILWAY' from shipping_order where id=?", Boolean.class, order))) {
            throw referenceError("Добавьте хотя бы один вагон в ЖД-вывоз", "Shipping order must contain railway carriages");
        }
    }

    private void rejectStockViolations(StockViolations violations) {
        if (!violations.isEmpty()) throw referenceError(violations.detail(), violations.originalMessage());
    }

    private ApiException referenceError(String message, String originalMessage) {
        return new ApiException(HttpStatus.BAD_REQUEST, "SHIPPING_STOCK_CONFLICT", message, originalMessage);
    }

    private void checkAutoPlan(UUID order) {
        var plans=jdbc.query("select owner_client_id,type,quantity,empty from shipping_order_container_qty where shipping_order_id=?",
                (rs,n)->new AutoPlan(rs.getObject(1,UUID.class),rs.getString(2),rs.getInt(3),rs.getBoolean(4)),order);
        if (plans.size()!=1 || plans.getFirst().quantity()!=1 || !plans.getFirst().empty()) throw referenceError("Для безномерного автовывоза укажите один порожний КТК", "ShippingOrder.InvalidNoneContainerData");
        var plan=plans.getFirst();
        if (plan.owner()==null) throw referenceError("Укажите собственника КТК", "ShippingOrderContainerQty.MissingOwnerClient");
        var types=jdbc.queryForList("""
                select distinct c.container_type from container_owner_current o join container c on c.id=o.container_id
                where o.client_id=? and o.status='ON_TERMINAL'
                """,String.class,plan.owner());
        if (types.isEmpty()) throw referenceError("У выбранного собственника нет свободных КТК на терминале",
                "ShippingOrderContainerQty.OwnerHasNoOnTerminalContainers");
        if (!types.contains(plan.type())) throw referenceError("У выбранного собственника нет свободного КТК нужного типоразмера",
                "ShippingOrderContainerQty.MissingOwnerClientWithNeededContainerType");
    }
    private record AutoPlan(UUID owner, String type, int quantity, boolean empty) {}

    public void complete(boolean receiving, UUID order) {
        var wagons = wagons(receiving ? RECEIPTS : SHIPMENTS, order);
        if (wagons.isEmpty()) {
            checkEmptyComposition(receiving, order);
            return;
        }
        String reserved = receiving ? "EXPECTED" : "RESERVED_OUT";
        String completed = receiving ? "ON_TERMINAL" : "DEPARTED";
        for (var wagon : wagons) {
            if (receiving && !order.equals(wagon.receivingOrder())) {
                throw referenceError("Вагон " + wagon.code() + " не зарезервирован этой поставкой",
                        "Railway carriage has no reservation for receiving: " + wagon.code());
            }
            boolean validStatus = reserved.equals(wagon.status()) || completed.equals(wagon.status());
            if (receiving && !validStatus) {
                throw referenceError("Текущее состояние вагона " + wagon.code() + " не допускает приёмку",
                        "Railway carriage cannot be received in status " + wagon.status() + ": " + wagon.code());
            }
            if (!receiving && (!order.equals(wagon.shippingOrder()) || !validStatus)) {
                throw referenceError("Вагон " + wagon.code() + " нельзя вывезти по этой заявке",
                        "Railway carriage cannot be shipped: " + wagon.id());
            }
        }
        for (var wagon : wagons) {
            if (reserved.equals(wagon.status())) record(wagon.id(), wagon.owner(),
                    receiving ? order : null, receiving ? null : order, completed);
        }
    }

    public void checkCancellation(boolean receiving, UUID order, String previousStatus) {
        if ("DRAFT".equals(previousStatus)) return;
        var wagons = wagons(receiving ? RECEIPTS : SHIPMENTS, order);
        var violations = new StockViolations();
        for (var wagon : wagons) {
            UUID current = receiving ? wagon.receivingOrder() : wagon.shippingOrder();
            if ("DONE".equals(previousStatus)) {
                wagon.addViolation(violations, ContainerStockPolicy.completedCancellationViolation(
                        receiving, wagon.status(), current, order));
            } else if (!order.equals(current)) {
                throw invalid("Сначала отмените последующую операцию по вагону " + wagon.code());
            }
        }
        rejectStockViolations(violations);
    }

    private void record(UUID carriage, UUID client, UUID receiving, UUID shipping, String status) {
        jdbc.update("""
                insert into railway_carriage_owner_history(railway_carriage_id,client_owner_id,receiving_order_id,shipping_order_id,status)
                values (?,?,?,?,?)
                """, carriage, client, receiving, shipping, status);
    }
    private ApiException invalid(String message) { return new ApiException(HttpStatus.CONFLICT,"SHIPPING_STOCK_CONFLICT",message); }
}
