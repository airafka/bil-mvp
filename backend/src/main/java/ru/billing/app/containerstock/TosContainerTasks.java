package ru.billing.app.containerstock;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import ru.billing.app.error.ApiException;
import ru.billing.app.integration.TosEvent;
import ru.billing.app.order.FillingType;

@Service
public class TosContainerTasks {
    private final JdbcTemplate jdbc;
    private final ContainerTaskRows tasks;
    private final ContainerStockService stock;

    public TosContainerTasks(JdbcTemplate jdbc, ContainerTaskRows tasks, ContainerStockService stock) {
        this.jdbc = jdbc;
        this.tasks = tasks;
        this.stock = stock;
    }

    /** The caller holds the route and document locks throughout assignment and completion. */
    public void process(TosEvent event, boolean receiving, FillingType mode) {
        var cargo = event.cargoResult();
        if (cargo.isEmpty() && event.addServicesResult().isEmpty())
            throw invalid("Пакет не содержит результатов");
        if (receiving || mode == FillingType.ALL || mode == FillingType.CONTAINER) {
            var row = tasks.rows(event.orderId(), receiving).stream()
                    .filter(task -> task.id().equals(event.taskId())).findFirst()
                    .orElseThrow(() -> invalid("Задание _id отсутствует в заявке _order"));
            if ("FINISHED".equals(row.status())) return;
            if (mode == FillingType.CONTAINER) {
                if (cargo.size() != 1) throw invalid("Для задания КТК требуется один результат");
                var result = cargo.getFirst();
                requireContainer(row.container(), result.cargoNumber());
                var wagon = wagon(event.orderId(), result, false);
                jdbc.update("update shipping_order_container set shipping_order_railway_carriage_id=?,seal_numbers=? where id=?",
                        wagon, seals(result), row.id());
            }
            if (!cargo.isEmpty() && !row.table().equals("waybill_container"))
                jdbc.update("update "+row.table()+" set actual_quantity=? where id=?",cargo.getFirst().qty(),row.id());
            stock.finishContainers(receiving ? "receiving-orders" : "shipping-orders",event.orderId(),
                    row.container(),event.eventDateTime());
            return;
        }

        if (cargo.isEmpty() || (mode == FillingType.NONE_CONTAINER && cargo.size() != 1))
            throw invalid("Для безномерного вывоза требуется результат по фактическому КТК");
        var containerIds = cargo.stream().map(c -> reference("container",c.cargoNumber())).toList();
        if (new HashSet<>(containerIds).size() != containerIds.size()) throw invalid("Номер КТК повторяется в пакете");
        ContainerLocks.lockCurrentOwners(jdbc,containerIds);
        var order = event.orderId();
        long existing = jdbc.queryForObject("select count(*) from shipping_order_container where shipping_order_id=?",Long.class,order);
        if (existing + cargo.size() > plannedContainers(order)) throw invalid("Превышено количество КТК заявки");
        for (int i=0; i<cargo.size(); i++) {
            var result = cargo.get(i);
            UUID container = containerIds.get(i);
            UUID row = i == 0 ? event.taskId() : UUID.nameUUIDFromBytes(
                    (event.taskId()+"/"+container).getBytes(StandardCharsets.UTF_8));
            var state = stock.state(container);
            String conflict = ContainerStockPolicy.reservationConflict(false, state == null ? null : state.status());
            if (conflict != null) throw invalid(result.cargoNumber()+": "+conflict);
            boolean vehicle = mode == FillingType.NONE_CONTAINER;
            UUID carriage = vehicle ? null : wagon(order,result,mode == FillingType.RAILWAY_CARRIAGE);
            jdbc.update("""
                    insert into shipping_order_container(id,shipping_order_id,container_id,shipping_order_railway_carriage_id,
                        owner_container_id,empty,seal_numbers,status,actual_quantity) values(?,?,?,?,?,?,?,'UPLOADED',?)
                    """,row,order,container,carriage,state.client(),vehicle || result.cargoSpec().isEmpty(),seals(result),result.qty());
            if (!vehicle) for (var item : result.cargoSpec()) {
                if (item.code()==null || item.qty()==null || item.qty().signum()<=0) throw invalid("Не указан код ЕТСНГ или масса груза");
                jdbc.update("insert into shipping_order_container_item(id,shipping_order_container_id,etsng_code_id,wight_net) values(?,?,?,?)",
                        UUID.randomUUID(),row,reference("etsng_code",item.code()),item.qty());
            }
            stock.transition(container,state.client(),"RESERVED_OUT",state.receiving(),order,order,"SHIPPING_ORDER",event.eventDateTime());
            stock.finishContainers("shipping-orders",order,container,event.eventDateTime());
        }
    }

    public long plannedContainers(UUID order) {
        return jdbc.queryForObject("select coalesce(sum(quantity),0) from shipping_order_container_qty where shipping_order_id=?",Long.class,order);
    }

    private UUID wagon(UUID order, TosEvent.Cargo cargo, boolean mustExist) {
        if (!"ЖД".equals(cargo.transportType())) throw invalid("В ЖД-результате требуется вагон");
        UUID carriage = reference("railway_carriage",cargo.transportNumber());
        var rows = jdbc.query("select id from shipping_order_railway_carriage where shipping_order_id=? and railway_carriage_id=?",
                (rs,n)->rs.getObject(1,UUID.class),order,carriage);
        if (!rows.isEmpty()) {
            jdbc.update("update shipping_order_railway_carriage set status='FINISHED' where id=?",rows.getFirst());
            return rows.getFirst();
        }
        if (mustExist) throw invalid("Вагон отсутствует в составе заявки");
        var id = UUID.randomUUID();
        jdbc.update("insert into shipping_order_railway_carriage(id,shipping_order_id,railway_carriage_id,status) values(?,?,?,'FINISHED')",
                id,order,carriage);
        return id;
    }

    private UUID reference(String table, String code) {
        var matches=jdbc.query("select id from "+table+" where upper(code)=upper(?)",(rs,n)->rs.getObject(1,UUID.class),code);
        if (matches.size()!=1) throw invalid("Номер отсутствует или неоднозначен в справочнике: "+code);
        return matches.getFirst();
    }

    private void requireContainer(UUID container, String code) {
        if (!container.equals(reference("container",code))) throw invalid("Номер КТК не соответствует заданию");
    }

    private String seals(TosEvent.Cargo cargo) {
        return cargo.seals().stream().map(TosEvent.Seal::code).filter(s -> s!=null && !s.isBlank()).collect(Collectors.joining(", "));
    }

    private ApiException invalid(String message) {
        return new ApiException(HttpStatus.CONFLICT,"INVALID_TOS_RESULT",message);
    }
}
