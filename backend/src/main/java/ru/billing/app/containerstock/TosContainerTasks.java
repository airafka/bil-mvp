package ru.billing.app.containerstock;

import java.util.List;
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
        if (receiving || mode == FillingType.ALL) {
            var row = tasks.rows(event.orderId(), receiving).stream()
                    .filter(task -> task.id().equals(event.taskId())).findFirst()
                    .orElseThrow(() -> invalid("Задание _id отсутствует в заявке _order"));
            if ("FINISHED".equals(row.status())) return;
            if (!cargo.isEmpty() && !row.table().equals("waybill_container"))
                jdbc.update("update "+row.table()+" set actual_quantity=? where id=?",cargo.getFirst().qty(),row.id());
            stock.finishContainers(receiving ? "receiving-orders" : "shipping-orders",event.orderId(),
                    row.container(),event.eventDateTime());
            return;
        }

        if (cargo.size() != 1) throw invalid("Для автовывоза требуется результат по одному КТК");
        var result = cargo.getFirst();
        var matches = jdbc.queryForList("select id from container where upper(code)=upper(?)", UUID.class, result.cargoNumber());
        if (matches.size()!=1) throw invalid("Номер КТК отсутствует или неоднозначен в справочнике: "+result.cargoNumber());
        UUID container = matches.getFirst();
        UUID order = event.orderId();
        ContainerLocks.lockCurrentOwners(jdbc, List.of(container));
        if (!Boolean.TRUE.equals(jdbc.queryForObject("""
                select exists(select 1 from shipping_order_container_qty where shipping_order_id=?)
                   and not exists(select 1 from shipping_order_container where shipping_order_id=?)
                """, Boolean.class, order, order))) throw invalid("Нет свободной позиции КТК в плане вывоза");
        var state = stock.state(container);
        String conflict = ContainerStockPolicy.reservationConflict(false, state == null ? null : state.status());
        if (conflict != null) throw invalid(result.cargoNumber()+": "+conflict);
        jdbc.update("""
                insert into shipping_order_container(id,shipping_order_id,container_id,owner_container_id,empty,seal_numbers,status,actual_quantity)
                values(?,?,?,?,true,?,'UPLOADED',?)
                """,event.taskId(),order,container,state.client(),seals(result),result.qty());
        stock.transition(container,state.client(),"RESERVED_OUT",state.receiving(),order,order,"SHIPPING_ORDER",event.eventDateTime());
        stock.finishContainers("shipping-orders",order,container,event.eventDateTime());
    }

    private String seals(TosEvent.Cargo cargo) {
        return cargo.seals().stream().map(TosEvent.Seal::code).filter(s -> s!=null && !s.isBlank()).collect(Collectors.joining(", "));
    }

    private ApiException invalid(String message) {
        return new ApiException(HttpStatus.CONFLICT,"INVALID_TOS_RESULT",message);
    }
}
