package ru.billing.app.order;

import java.time.OffsetDateTime;
import java.util.UUID;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.error.ApiException;
import ru.billing.app.billing.BillingCancellationService;
import ru.billing.app.containerstock.ContainerStockService;
import ru.billing.app.comprehensiveserviceorder.ServiceOrderLock;

@Service
public class OrderCancellationService {
    public record Request(@NotBlank String expectedStatus,@NotBlank @Size(max=1000) String reason) {}
    public record Cancellation(String previousStatus,String reason,OffsetDateTime cancelledAt) {}
    private final JdbcTemplate jdbc;
    private final ContainerStockService stock;
    private final BillingCancellationService billing;
    private final ReceivingOrderStore receiving;
    private final ShippingOrderStore shipping;
    public OrderCancellationService(JdbcTemplate jdbc,ContainerStockService stock,BillingCancellationService billing,
            ReceivingOrderStore receiving,ShippingOrderStore shipping) {
        this.jdbc=jdbc;this.stock=stock;this.billing=billing;this.receiving=receiving;this.shipping=shipping;
    }
    @Transactional(readOnly=true)
    public Cancellation details(String resource,UUID id) {
        var rows=jdbc.query("select previous_status,reason,cancelled_at from order_cancellation where resource=? and order_id=?",
            (rs,n)->new Cancellation(rs.getString(1),rs.getString(2),rs.getObject(3,OffsetDateTime.class)),resource,id);
        return rows.isEmpty()?null:rows.getFirst();
    }
    @Transactional
    public CreatedOrderResponse cancel(String resource,UUID id,Request request) {
        boolean incoming=resource.equals("receiving-orders");
        String table=switch(resource) {case "receiving-orders" -> "receiving_order"; case "shipping-orders" -> "shipping_order";
            default -> throw new ApiException(HttpStatus.NOT_FOUND,"ORDER_NOT_FOUND","Заявка не найдена");};
        jdbc.query("select comprehensive_service_order_id from "+table+" where id=?",(rs,n)->rs.getObject(1,UUID.class),id)
            .stream().filter(java.util.Objects::nonNull).forEach(parent->ServiceOrderLock.lock(jdbc,parent));
        var routeRows=jdbc.query("select route_id from "+table+" where id=?",(rs,n)->rs.getObject(1,UUID.class),id);
        UUID observedRoute=routeRows.isEmpty()?null:routeRows.getFirst();
        jdbc.query("select r.id from route r join "+table+" o on o.route_id=r.id where o.id=? for update of r",(rs,n)->rs.getObject(1,UUID.class),id);
        var rows=jdbc.query("select number,order_status from "+table+" where id=? for update",
            (rs,n)->new CreatedOrderResponse(id,rs.getInt(1),rs.getString(2)),id);
        if(rows.isEmpty())throw new ApiException(HttpStatus.NOT_FOUND,"ORDER_NOT_FOUND","Заявка не найдена");
        var current=rows.getFirst();
        var lockedRoute=jdbc.queryForObject("select route_id from "+table+" where id=?",UUID.class,id);
        if(!java.util.Objects.equals(observedRoute,lockedRoute))throw conflict("ROUTE_CHANGED","Рейс заявки изменился. Повторите отмену");
        if(current.status().equals("CANCELLED"))return current;
        if(!current.status().equals(request.expectedStatus()))throw conflict("STATUS_CHANGED","Статус изменился. Обновите заявку перед отменой");
        // Cancel dependencies explicitly, in reverse order. Nothing is silently cascaded.
        var dependent=jdbc.query(incoming?
            "select number from shipping_order where source_receiving_order_id=? and order_status<>'CANCELLED' order by number":
            "select number from receiving_order where source_shipping_order_id=? and order_status<>'CANCELLED' order by number",
            (rs,n)->rs.getString(1),id);
        if(!dependent.isEmpty())throw conflict("CANCELLATION_DEPENDENT_ORDERS","Сначала отмените связанные "+(incoming?"вывозы":"возвраты")+" №"+String.join(", ",dependent));
        var document=incoming?receiving.findById(id):shipping.findById(id);
        stock.cancel(resource,id,current.status(),request.reason().trim());
        OrderCancellationArchive.save(jdbc,resource,id,request.reason().trim(),document);
        billing.cancel(resource,id);
        jdbc.update("update "+table+" set order_status='CANCELLED' where id=?",id);
        if(incoming) {
            // Header keeps the source for the document history; row link represents an active allocation.
            jdbc.update("update receiving_order_container set source_shipping_order_id=null where receiving_order_id=?",id);
            jdbc.update("update waybill set receiving_order_id=null where receiving_order_id=?",id);
        } else jdbc.update("delete from shipping_order_source_container where shipping_order_id=?",id);
        if(current.status().equals("CONFIRMED")) jdbc.update("""
            insert into outbound_data(id,message_type,entity_type,root_object_id) values(?,?,?,?)
            on conflict(message_type,root_object_id) do nothing
            """,UUID.randomUUID(),incoming?"RECEIVING_ORDER_CANCEL":"SHIPPING_ORDER_CANCEL",incoming?"RECEIVING_ORDER":"SHIPPING_ORDER",id);
        refreshRoute(table,id);
        refreshServices(table,id);
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
    private void refreshServices(String table,UUID id) {
        jdbc.update("""
            update comprehensive_service_order s set status=case
              when not exists(select 1 from receiving_order where comprehensive_service_order_id=s.id and order_status<>'CANCELLED')
               and not exists(select 1 from shipping_order where comprehensive_service_order_id=s.id and order_status<>'CANCELLED') then 'CANCELLED'
              when s.status='COMPLETED' then 'CONFIRMED' else s.status end
            where s.id in (select comprehensive_service_order_id from %s where id=?
              union select source_service_order_id from comprehensive_service_order where id=(select comprehensive_service_order_id from %s where id=?))
            """.formatted(table,table),id,id);
    }
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
