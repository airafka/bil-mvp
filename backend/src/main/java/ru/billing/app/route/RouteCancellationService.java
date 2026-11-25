package ru.billing.app.route;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import ru.billing.app.order.OrderCancellationService;
import com.fasterxml.jackson.annotation.JsonProperty;
import ru.billing.app.error.ApiException;

@Service
public class RouteCancellationService {
    private final JdbcTemplate jdbc;
    private final OrderCancellationService orders;
    public RouteCancellationService(JdbcTemplate jdbc,OrderCancellationService orders){this.jdbc=jdbc;this.orders=orders;}
    public record Result(UUID id, int number, String status) {
        @JsonProperty("code") public int code() { return number; }
    }
    private record Member(UUID id,String resource,String status) {}
    private List<Member> members(UUID id) {
        return jdbc.query("""
            select id,'receiving-orders',order_status from receiving_order where route_id=?
            union all select id,'shipping-orders',order_status from shipping_order where route_id=? order by id
            """,(rs,n)->new Member(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3)),id,id);
    }
    @Transactional
    public Result cancel(UUID id,OrderCancellationService.Request request) {
        var initial=members(id);
        var routes=jdbc.query("select number,status from route where id=? for update",(rs,n)->new Result(id,rs.getInt(1),rs.getString(2)),id);
        if (routes.isEmpty()) throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "Рейс не найден", "NotFound");
        var route=routes.getFirst();if(route.status().equals("REJECTED"))return route;
        if(!route.status().equals(request.expectedStatus()))throw conflict("STATUS_CHANGED","Статус рейса изменился. Обновите страницу");
        var current=members(id);
        if(!new HashSet<>(initial).equals(new HashSet<>(current)))throw conflict("ROUTE_CHANGED","Состав или статусы заявок рейса изменились. Повторите отмену");
        // Lock all document headers before the union of KTK; individual cancellation
        // must not acquire a new header while holding a container from another order.
        for(var member:current) jdbc.queryForList("select id from "+(member.resource().equals("receiving-orders")?"receiving_order":"shipping_order")+" where id=? for update",member.id());
        ru.billing.app.containerstock.ContainerLocks.lockOrders(jdbc,
                current.stream().filter(m->!m.status().equals("REJECTED")&&m.resource().equals("receiving-orders")).map(Member::id).toList(),
                current.stream().filter(m->!m.status().equals("REJECTED")&&m.resource().equals("shipping-orders")).map(Member::id).toList());
        for(var member:current)if(!member.status().equals("REJECTED"))orders.cancel(member.resource(),member.id(),
            new OrderCancellationService.Request(member.status()));
        jdbc.update("update route set status='REJECTED' where id=?",id);
        return new Result(id,route.code(),"REJECTED");
    }
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
