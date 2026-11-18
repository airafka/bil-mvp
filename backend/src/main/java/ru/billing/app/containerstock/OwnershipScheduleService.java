package ru.billing.app.containerstock;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;

/** One transaction per order; the order and physical KTK locks also protect retries and withdrawal. */
@Service
public class OwnershipScheduleService {
    private final JdbcTemplate jdbc;
    private final ContainerStockService stock;
    public OwnershipScheduleService(JdbcTemplate jdbc, ContainerStockService stock) { this.jdbc=jdbc; this.stock=stock; }

    @Transactional
    public void execute(UUID id) {
        var rows=jdbc.query("select client_id from service_order where id=? and status='SCHEDULED' for update",
            (rs,n)->rs.getObject(1,UUID.class),id);
        if(rows.isEmpty()) return;
        // Recheck the shared business clock inside this transaction, after acquiring the order lock.
        OffsetDateTime at=jdbc.queryForObject("""
            select case when effective_date<=billing_today() then greatest(
                effective_date::timestamp at time zone 'Europe/Moscow', updated_at at time zone 'UTC') end
            from service_order where id=?
            """,OffsetDateTime.class,id);
        if(at==null) return;
        var containers=jdbc.query("select container_id from service_order_container where service_order_id=? order by container_id",
            (rs,n)->rs.getObject(1,UUID.class),id);
        if(containers.isEmpty()) throw conflict("В ожидающей заявке не выбраны КТК");
        stock.lockContainers(containers,id);
        for(UUID container:containers) {
            var state=stock.state(container);
            if(state==null) throw conflict("У КТК нет текущего собственника");
            if(state.client().equals(rows.getFirst())) throw conflict("КТК уже принадлежит новому собственнику. Верните заявку в черновик и проверьте состав");
            stock.transition(container,rows.getFirst(),state.status(),state.receiving(),state.shipping(),id,"SERVICE_ORDER",at);
        }
        jdbc.update("update service_order set status='DONE',completion_at=billing_now() at time zone 'UTC',updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",id);
        jdbc.update("insert into outbound_data(id,message_type,entity_type,root_object_id) values(?,'SERVICE_ORDER_CHAIN_PACKAGE','SERVICE_ORDER',?)",UUID.randomUUID(),id);
    }
    private ApiException conflict(String message) { return new ApiException(HttpStatus.CONFLICT,"OWNERSHIP_SCHEDULE_CONFLICT",message); }
}
