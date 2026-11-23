package ru.billing.app.order;

import java.util.UUID;
import ru.billing.app.containerstock.TosContainerTasks;
import ru.billing.app.integration.TosEvent;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.error.ApiException;

@org.springframework.stereotype.Service
public class OrderStatusService {
    private final JdbcTemplate jdbc;
    private final ru.billing.app.billing.BillingService billing;
    private final ru.billing.app.containerstock.ContainerStockService stock;
    private final TosContainerTasks tos;
    private final ru.billing.app.containerstock.RailwayCarriageStock wagons;
    public OrderStatusService(JdbcTemplate jdbc, ru.billing.app.billing.BillingService billing, ru.billing.app.containerstock.ContainerStockService stock,TosContainerTasks tos, ru.billing.app.containerstock.RailwayCarriageStock wagons) { this.wagons=wagons; this.tos=tos; this.jdbc = jdbc; this.billing = billing; this.stock = stock; }

    @Transactional
    public CreatedOrderResponse finish(String resource, UUID id, String eventCode) {
        return finish(resource,id,eventCode,null);
    }

    @Transactional
    public CreatedOrderResponse finish(String resource, UUID id, String eventCode, UUID containerId) {
        boolean receiving = resource.equals("receiving-orders");
        if (!(receiving ? "UNLOAD_FINISH" : "LOAD_FINISH").equals(eventCode))
            throw new ApiException(HttpStatus.BAD_REQUEST,"INVALID_CONTAINER_EVENT","Для поставки требуется UNLOAD_FINISH, для вывоза — LOAD_FINISH");
        lockOrderRoute(resource,id);
        return changeInternal(resource,id,new ChangeStatusRequest(Status.CONFIRMED,Status.COMPLETED),containerId,true);
    }

    @Transactional
    public void finishTos(TosEvent event, boolean receiving) {
        String resource = receiving ? "receiving-orders" : "shipping-orders";
        String table = receiving ? "receiving_order" : "shipping_order";
        String mode = receiving ? "'ALL'" : "o.filling_type";
        UUID order = event.orderId();
        lockOrderRoute(resource,order);
        record Document(String status,FillingType mode) {}
        var docs = jdbc.query("select o.order_status,"+mode+" from "+table+" o join terminal_area_catalog a on a.id=o.terminal_area_catalog_id where o.id=? and lower(a.name)=lower(?) for update of o",
                (rs,n)->new Document(rs.getString(1),FillingType.valueOf(rs.getString(2))),order,event.site());
        if (docs.isEmpty()) throw new ApiException(HttpStatus.NOT_FOUND,"TOS_ORDER_NOT_FOUND","Заявка или площадка пакета не найдена");
        var doc=docs.getFirst();
        if (Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from inbound_event where order_id=? and task_id=? and event_code=? and status='DONE')",Boolean.class,order,event.taskId(),event.eventCode()))) return;
        if (!doc.status().equals("CONFIRMED") && !doc.status().equals("COMPLETED"))
            throw new ApiException(HttpStatus.CONFLICT,"TOS_ORDER_STATUS","Заявка не подтверждена");
        if (doc.status().equals("COMPLETED") && !receiving && doc.mode()!=FillingType.ALL && doc.mode()!=FillingType.CONTAINER)
            throw new ApiException(HttpStatus.CONFLICT,"TOS_ORDER_COMPLETED","Новая строка для выполненной заявки недопустима");
        validateSource(resource,order);
        tos.process(event,receiving,doc.mode());
        if (!doc.status().equals("COMPLETED") && stock.allTasksFinished(order,receiving) && (receiving || completeComposition(order,doc.mode())))
            complete(resource,order,table,"order_status");
    }

    private boolean completeComposition(UUID order,FillingType mode) {
        if (mode == FillingType.ALL) return true;
        if (mode == FillingType.CONTAINER)
            return !Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from shipping_order_container where shipping_order_id=? and shipping_order_railway_carriage_id is null)",Boolean.class,order));
        return tos.plannedContainers(order) == jdbc.queryForObject("select count(*) from shipping_order_container where shipping_order_id=? and status='FINISHED'",Long.class,order);
    }

    public enum Status { DRAFT, CONFIRMED, COMPLETED }
    public record ChangeStatusRequest(@NotNull Status expectedStatus, @NotNull Status status) {}

    @Transactional
    public CreatedOrderResponse change(String resource, UUID id,
            ChangeStatusRequest request) {
        if (!resource.equals("comprehensive-service-orders") && request.status() == Status.CONFIRMED)
            throw new ApiException(HttpStatus.CONFLICT, "CONFIRM_THROUGH_ROUTE", "Подтвердите заявку через рейс");
        if(resource.equals("comprehensive-service-orders")) throw new ApiException(HttpStatus.CONFLICT,"SERVICE_STATUS_AUTOMATIC","Статус услуги меняется автоматически после выполнения связанных заявок");
        lockOrderRoute(resource, id);
        return changeInternal(resource, id, request,null,false);
    }

    private CreatedOrderResponse changeInternal(String resource, UUID id, ChangeStatusRequest request, UUID containerId, boolean resultEvent) {
        String table = switch (resource) {
            case "receiving-orders" -> "receiving_order";
            case "shipping-orders" -> "shipping_order";
            case "comprehensive-service-orders" -> "comprehensive_service_order";
            default -> throw new ApiException(HttpStatus.NOT_FOUND, "ORDER_NOT_FOUND", "Заявка не найдена");
        };
        String numberColumn = "comprehensive-service-orders".equals(resource) ? "code" : "number";
        String statusColumn = "comprehensive-service-orders".equals(resource) ? "status" : "order_status";
        var rows = jdbc.query("select " + numberColumn + " as code, " + statusColumn + " as status from " + table + " where id = ? for update",
                (rs, row) -> new CreatedOrderResponse(id, rs.getInt("code"), rs.getString("status")), id);
        if (rows.isEmpty()) throw new ApiException(HttpStatus.NOT_FOUND, "ORDER_NOT_FOUND", "Заявка не найдена");
        var current = rows.getFirst();
        if(resultEvent && current.status().equals("COMPLETED")){
            if(containerId!=null) stock.verifyFinished(resource,id,containerId);
            return current;
        }
        if (!current.status().equals(request.expectedStatus().name())) {
            throw new ApiException(HttpStatus.CONFLICT, "STATUS_CHANGED", "Статус уже изменён. Обновите страницу перед следующим действием.");
        }
        boolean allowed = request.expectedStatus() == Status.DRAFT && request.status() == Status.CONFIRMED
                || request.expectedStatus() == Status.CONFIRMED && request.status() == Status.COMPLETED;
        if (!allowed) throw new ApiException(HttpStatus.CONFLICT, "INVALID_STATUS_TRANSITION",
                "Допустимы только переходы: Черновик → Подтверждено → Выполнено");
        validateSource(resource,id);
        if ("comprehensive-service-orders".equals(resource) && request.status() == Status.COMPLETED) {
            Integer unfinishedReceiving = jdbc.queryForObject("select count(*) from receiving_order where comprehensive_service_order_id = ? and order_status <> 'COMPLETED'", Integer.class, id);
            Integer unfinishedShipping = jdbc.queryForObject("select count(*) from shipping_order where comprehensive_service_order_id = ? and order_status <> 'COMPLETED'", Integer.class, id);
            if ((unfinishedReceiving != null && unfinishedReceiving > 0) || (unfinishedShipping != null && unfinishedShipping > 0)) {
                throw new ApiException(HttpStatus.CONFLICT, "SERVICE_CHILD_ORDERS_UNFINISHED",
                        "Завершите связанные поставки и вывозы перед выполнением услуги");
            }
            Integer remaining = jdbc.queryForObject("""
                    select count(distinct wc.container_id)
                    from receiving_order r
                    join waybill_details w on w.receiving_order_id = r.id
                    join waybill_railway_carriage rc on rc.waybill_id = w.id
                    join waybill_container_details wc on wc.waybill_railway_carriage_id = rc.id
                    where r.comprehensive_service_order_id = ? and not exists (
                        select 1 from shipping_order_source_container link
                        where link.comprehensive_service_order_id = r.comprehensive_service_order_id
                          and link.container_id = wc.container_id
                    )
                    """, Integer.class, id);
            if (remaining != null && remaining > 0) throw new ApiException(HttpStatus.CONFLICT,
                    "SERVICE_CONTAINERS_UNASSIGNED", "Создайте заявки на вывоз для всех КТК перед выполнением услуги");
        }
        if(request.status()==Status.CONFIRMED) {
            stock.reserve(resource,id);
            wagons.confirm(resource.equals("receiving-orders"),id);
        }
        else {
            if ("shipping-orders".equals(resource) && !"ALL".equals(jdbc.queryForObject("select filling_type from shipping_order where id=?",String.class,id)))
                throw new ApiException(HttpStatus.CONFLICT,"TOS_RESULT_REQUIRED","Для безномерного вывоза нужны фактические номера из пакета TOS");
            if (!stock.finishContainers(resource,id,containerId,null)) return current;
        }
        if (request.status() == Status.COMPLETED) complete(resource,id,table,statusColumn);
        else jdbc.update("update " + table + " set " + statusColumn + " = ? where id = ?", request.status().name(), id);
        return new CreatedOrderResponse(id, current.code(), request.status().name());
    }
    private void validateSource(String resource,UUID id) {
        if ("receiving-orders".equals(resource)) {
            var sourceCompleted = jdbc.query("""
                    select sh.order_status = 'COMPLETED' from receiving_order r
                    join shipping_order sh on sh.id = r.source_shipping_order_id
                    where r.id = ? and r.service_role = 'RETURN_RECEIVING'
                    """, (rs, row) -> rs.getBoolean(1), id);
            if (!sourceCompleted.isEmpty() && Boolean.FALSE.equals(sourceCompleted.getFirst())) throw new ApiException(HttpStatus.CONFLICT,
                    "SOURCE_SHIPPING_NOT_COMPLETED", "Сначала выполните исходный вывоз");
        }
    }

    private void complete(String resource,UUID id,String table,String statusColumn) {
        if (!resource.equals("comprehensive-service-orders")) wagons.complete(resource.equals("receiving-orders"),id);
        billing.complete(resource, id);
        jdbc.update("update " + table + " set " + statusColumn + " = ? where id = ?", Status.COMPLETED.name(), id);
        if (!resource.equals("comprehensive-service-orders")) {
            jdbc.update("""
                update route r set status='COMPLETED'
                where r.id=(select route_id from %s where id=?) and r.status='CONFIRMED'
                  and not exists (select 1 from receiving_order where route_id=r.id and order_status not in ('COMPLETED','CANCELLED'))
                  and not exists (select 1 from shipping_order where route_id=r.id and order_status not in ('COMPLETED','CANCELLED'))
                """.formatted(table), id);
        }
        if (!resource.equals("comprehensive-service-orders")) {
            jdbc.query("select comprehensive_service_order_id from "+table+" where id=? union select source_service_order_id from comprehensive_service_order where id=(select comprehensive_service_order_id from "+table+" where id=?)",
                (rs,n)->rs.getObject(1,UUID.class),id,id).stream().filter(java.util.Objects::nonNull)
                .forEach(parent->ru.billing.app.comprehensiveserviceorder.ServiceCompletion.refresh(jdbc,parent));
        }
    }

    // All lifecycle operations lock the route before its orders, including concurrent completions.
    private void lockOrderRoute(String resource, UUID id) {
        String table = switch(resource) {
            case "receiving-orders" -> "receiving_order";
            case "shipping-orders" -> "shipping_order";
            default -> null;
        };
        if(table != null) jdbc.query("select comprehensive_service_order_id from " + table + " where id=?", (rs,n)->rs.getObject(1,UUID.class),id).stream().filter(java.util.Objects::nonNull).forEach(parent -> ru.billing.app.comprehensiveserviceorder.ServiceOrderLock.lock(jdbc,parent));
        if (table != null) jdbc.query("select r.id from route r join " + table + " o on o.route_id=r.id where o.id=? for update of r", (rs,n)->rs.getObject(1, UUID.class), id);
    }

    @Transactional
    public void confirmRoute(UUID routeId) {
        var routes=jdbc.query("select status from route where id=? for update", (rs,n)->rs.getString(1), routeId);
        if(routes.isEmpty()) throw new ApiException(HttpStatus.NOT_FOUND,"ROUTE_NOT_FOUND","Рейс не найден");
        if(!routes.getFirst().equals("DRAFT")) throw new ApiException(HttpStatus.CONFLICT,"ROUTE_NOT_DRAFT","Рейс уже подтверждён. Обновите страницу");
        record Order(String resource, UUID id, int number, String status, boolean dateMissing, boolean partyMissing) {}
        var orders=new java.util.ArrayList<Order>();
        orders.addAll(jdbc.query("select id,number,order_status,plan_receiving_date_time,consignor from receiving_order where route_id=? and order_status<>'CANCELLED' order by id for update",
            (rs,n)->new Order("receiving-orders",rs.getObject(1,UUID.class),rs.getInt(2),rs.getString(3),rs.getObject(4)==null,rs.getString(5)==null||rs.getString(5).isBlank()),routeId));
        orders.addAll(jdbc.query("select s.id,s.number,s.order_status,s.planned_shipping_date_time,(select name from client_related_entity where id=s.consignee_id) from shipping_order s where s.route_id=? and s.order_status<>'CANCELLED' order by s.id for update of s",
            (rs,n)->new Order("shipping-orders",rs.getObject(1,UUID.class),rs.getInt(2),rs.getString(3),rs.getObject(4)==null,rs.getString(5)==null||rs.getString(5).isBlank()),routeId));
        if(orders.isEmpty()) throw new ApiException(HttpStatus.CONFLICT,"ROUTE_EMPTY","Добавьте заявки в рейс");
        var errors=new java.util.ArrayList<String>();
        for(var order:orders) {
            if(!order.status().equals("DRAFT")) throw new ApiException(HttpStatus.CONFLICT,"ORDER_NOT_DRAFT","Заявка №"+order.number()+" уже не в статусе Черновик");
            var fields=new java.util.ArrayList<String>();
            if(order.dateMissing()) fields.add(order.resource().equals("receiving-orders")?"Дата и время поступления":"Дата и время вывоза");
            if(order.partyMissing()) fields.add(order.resource().equals("receiving-orders")?"Грузоотправитель":"Грузополучатель");
            if(!fields.isEmpty()) errors.add("Заявка №"+order.number()+": "+String.join(", ",fields));
        }
        if(!errors.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST,"ORDER_CONFIRMATION_FIELDS_REQUIRED","Заполните обязательные поля. "+String.join("; ",errors));
        ru.billing.app.containerstock.ContainerLocks.lockOrders(jdbc,
                orders.stream().filter(o->o.resource().equals("receiving-orders")).map(Order::id).toList(),
                orders.stream().filter(o->o.resource().equals("shipping-orders")).map(Order::id).toList());
        for(var order:orders) changeInternal(order.resource(),order.id(),new ChangeStatusRequest(Status.DRAFT,Status.CONFIRMED),null,false);
        jdbc.update("update route set status='CONFIRMED' where id=?",routeId);
    }
}
