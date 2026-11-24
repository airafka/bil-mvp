package ru.billing.app.order;

import java.util.UUID;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.error.ApiException;
import ru.billing.app.containerstock.ContainerStockService;

@Service
public class OrderCancellationService {
    public record Request(@NotBlank String expectedStatus) {}
    private final JdbcTemplate jdbc;
    private final ContainerStockService stock;
    private final ru.billing.app.containerstock.RailwayCarriageStock wagons;
    public OrderCancellationService(JdbcTemplate jdbc,ContainerStockService stock,ru.billing.app.containerstock.RailwayCarriageStock wagons) {
        this.wagons=wagons;
        this.jdbc=jdbc;this.stock=stock;
    }
    @Transactional
    public CreatedOrderResponse cancel(String resource,UUID id,Request request) {
        boolean incoming=resource.equals("receiving-orders");
        String table=switch(resource) {case "receiving-orders" -> "receiving_order"; case "shipping-orders" -> "shipping_order";
            default -> throw new ApiException(HttpStatus.NOT_FOUND,"ORDER_NOT_FOUND","Заявка не найдена");};
        var routeRows=jdbc.query("select route_id from "+table+" where id=?",(rs,n)->rs.getObject(1,UUID.class),id);
        UUID observedRoute=routeRows.isEmpty()?null:routeRows.getFirst();
        jdbc.query("select r.id from route r join "+table+" o on o.route_id=r.id where o.id=? for update of r",(rs,n)->rs.getObject(1,UUID.class),id);
        var rows=jdbc.query("select number,order_status from "+table+" where id=? for update",
            (rs,n)->new CreatedOrderResponse(id,rs.getInt(1),rs.getString(2)),id);
        if (rows.isEmpty()) throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND, "ORDER_NOT_FOUND", "Заявка не найдена", "NotFound");
        var current=rows.getFirst();
        var lockedRoute=jdbc.queryForObject("select route_id from "+table+" where id=?",UUID.class,id);
        if(!java.util.Objects.equals(observedRoute,lockedRoute))throw conflict("ROUTE_CHANGED","Рейс заявки изменился. Повторите отмену");
        if(current.status().equals("CANCELLED"))return current;
        if(!current.status().equals(request.expectedStatus()))throw conflict("STATUS_CHANGED","Статус изменился. Обновите заявку перед отменой");
        stock.cancel(resource,id,current.status());
        wagons.checkCancellation(incoming,id,current.status());
        jdbc.update("update "+table+" set order_status='CANCELLED' where id=?",id);
        if(incoming) {
            jdbc.update("update waybill set receiving_order_id=null where receiving_order_id=?",id);
        }
        refreshRoute(table,id);
        return new CreatedOrderResponse(id,current.code(),"CANCELLED");
    }
    private void refreshRoute(String table,UUID id) {
        jdbc.update("""
            update route r set status=case
              when not exists(select 1 from receiving_order where route_id=r.id and order_status<>'CANCELLED')
               and not exists(select 1 from shipping_order where route_id=r.id and order_status<>'CANCELLED') then 'CANCELLED'
              when not exists(select 1 from receiving_order where route_id=r.id and order_status not in ('COMPLETED','CANCELLED'))
               and not exists(select 1 from shipping_order where route_id=r.id and order_status not in ('COMPLETED','CANCELLED')) then 'COMPLETED'
              else r.status end
            where r.id=(select route_id from %s where id=?)
            """.formatted(table),id);
    }
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
