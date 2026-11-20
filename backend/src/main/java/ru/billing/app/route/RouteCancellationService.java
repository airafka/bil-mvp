package ru.billing.app.route;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import ru.billing.app.order.OrderCancellationService;
import ru.billing.app.order.CreatedOrderResponse;
import ru.billing.app.error.ApiException;

@Service
public class RouteCancellationService {
    private final JdbcTemplate jdbc;
    private final OrderCancellationService orders;
    public RouteCancellationService(JdbcTemplate jdbc,OrderCancellationService orders){this.jdbc=jdbc;this.orders=orders;}
    private record Member(UUID id,String resource,String status,UUID parent) {}
    private List<Member> members(UUID id) {
        return jdbc.query("""
            select id,'receiving-orders',order_status,comprehensive_service_order_id from receiving_order where route_id=?
            union all select id,'shipping-orders',order_status,comprehensive_service_order_id from shipping_order where route_id=? order by id
            """,(rs,n)->new Member(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3),rs.getObject(4,UUID.class)),id,id);
    }
    @Transactional
    public CreatedOrderResponse cancel(UUID id,OrderCancellationService.Request request) {
        var initial=members(id);
        Set<UUID> parents=new HashSet<>();initial.stream().map(Member::parent).filter(Objects::nonNull).forEach(parents::add);
        // Same global order as transport lifecycle: original services, child services, route, orders, KTK.
        if(!parents.isEmpty()) {
            String params=String.join(",",Collections.nCopies(parents.size(),"?"));
            List<Object> args=new ArrayList<>(parents);args.addAll(parents);
            jdbc.query("select id from comprehensive_service_order where id in ("+params+") or id in (select source_service_order_id from comprehensive_service_order where id in ("+params+")) order by source_service_order_id nulls first,id for update",
                (rs,n)->rs.getObject(1,UUID.class),args.toArray());
        }
        var routes=jdbc.query("select number,status from route where id=? for update",(rs,n)->new CreatedOrderResponse(id,rs.getInt(1),rs.getString(2)),id);
        if(routes.isEmpty())throw new ApiException(HttpStatus.NOT_FOUND,"ROUTE_NOT_FOUND","Рейс не найден");
        var route=routes.getFirst();if(route.status().equals("CANCELLED"))return route;
        if(!route.status().equals(request.expectedStatus()))throw conflict("STATUS_CHANGED","Статус рейса изменился. Обновите страницу");
        var current=members(id);
        if(!new HashSet<>(initial).equals(new HashSet<>(current)))throw conflict("ROUTE_CHANGED","Состав или статусы заявок рейса изменились. Повторите отмену");
        // Lock all document headers before the union of KTK; individual cancellation
        // must not acquire a new header while holding a container from another order.
        for(var member:current) jdbc.queryForList("select id from "+(member.resource().equals("receiving-orders")?"receiving_order":"shipping_order")+" where id=? for update",member.id());
        ru.billing.app.containerstock.ContainerLocks.lockOrders(jdbc,
                current.stream().filter(m->!m.status().equals("CANCELLED")&&m.resource().equals("receiving-orders")).map(Member::id).toList(),
                current.stream().filter(m->!m.status().equals("CANCELLED")&&m.resource().equals("shipping-orders")).map(Member::id).toList());
        for(var member:current)if(!member.status().equals("CANCELLED"))orders.cancel(member.resource(),member.id(),
            new OrderCancellationService.Request(member.status()));
        jdbc.update("update route set status='CANCELLED' where id=?",id);
        return new CreatedOrderResponse(id,route.code(),"CANCELLED");
    }
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
