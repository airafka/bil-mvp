package ru.billing.app.containerstock;

import java.time.OffsetDateTime;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;

/** The order lock and sorted physical container locks protect execution, retries and withdrawal. */
@Service
public class OwnershipScheduleService {
    private final JdbcTemplate jdbc;
    private final ContainerStockService stock;
    public OwnershipScheduleService(JdbcTemplate jdbc, ContainerStockService stock) { this.jdbc=jdbc; this.stock=stock; }
    record Plan(UUID container,UUID visit,UUID expected,String expectedStatus,String result) {}

    @Transactional
    public void execute(UUID id) {
        var rows=jdbc.query("select client_id from service_order where id=? and status='SCHEDULED' for update",
            (rs,n)->rs.getObject(1,UUID.class),id);
        if(rows.isEmpty()) return;
        OffsetDateTime at=jdbc.queryForObject("""
            select case when effective_date<=billing_today() then greatest(
                effective_date::timestamp at time zone 'Europe/Moscow', updated_at at time zone 'UTC') end
            from service_order where id=?
            """,OffsetDateTime.class,id);
        var containers=jdbc.query("select container_id from service_order_container where service_order_id=? order by container_id",
            (rs,n)->rs.getObject(1,UUID.class),id);
        if(containers.isEmpty()) throw conflict("В ожидающей заявке не выбраны КТК");
        stock.lockContainers(containers,id);
        // Read after physical locks: shipping may have invalidated a line while we waited.
        var plans=jdbc.query("select * from service_order_container where service_order_id=? order by container_id",
            (rs,n)->new Plan(rs.getObject("container_id",UUID.class),rs.getObject("container_visit_id",UUID.class),
                rs.getObject("expected_client_id",UUID.class),rs.getString("expected_status"),rs.getString("result_status")),id);
        if(at==null && plans.stream().anyMatch(p->p.result().equals("PLANNED")||p.result().equals("BLOCKED"))) return;
        for(var p:plans) {
            if(!p.result().equals("PLANNED")&&!p.result().equals("BLOCKED")) continue;
            var state=stock.state(p.container());
            UUID visit=jdbc.queryForObject("select container_visit_id from container_owner where container_id=?",UUID.class,p.container());
            if(state==null || !Objects.equals(visit,p.visit()) || (state.status().equals("DEPARTED")&&!"DEPARTED".equals(p.expectedStatus()))) {
                jdbc.update("update service_order_container set result_status='SKIPPED',result_reason='Исходный receiving завершён или отменён; передача не переносится на другой receiving' where service_order_id=? and container_id=?",id,p.container());
                continue;
            }
            if(!Objects.equals(state.client(),p.expected())) throw conflict("Прежний собственник КТК изменился. Верните заявку в черновик и подтвердите её заново");
            if(state.client().equals(rows.getFirst())) throw conflict("КТК уже принадлежит новому собственнику. Проверьте состав заявки");
            stock.transition(p.container(),rows.getFirst(),state.status(),state.receiving(),state.shipping(),id,"SERVICE_ORDER",at);
            jdbc.update("update service_order_container set result_status='APPLIED',result_reason=null where service_order_id=? and container_id=?",id,p.container());
        }
        long applied=jdbc.queryForObject("select count(*) from service_order_container where service_order_id=? and result_status='APPLIED'",Long.class,id);
        String status=applied==0?"CANCELLED":applied==plans.size()?"DONE":"PARTIAL";
        jdbc.update("update service_order set status=?,completion_at=billing_now() at time zone 'UTC',updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",status,id);
        if(applied>0) jdbc.update("insert into outbound_data(id,message_type,entity_type,root_object_id) values(?,'SERVICE_ORDER_CHAIN_PACKAGE','SERVICE_ORDER',?)",UUID.randomUUID(),id);
    }

    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void recordFailure(UUID id,String message) {
        // updated_at fixes the accepted effective instant; failure logging must not move it.
        jdbc.update("update service_order_container sc set result_reason=? from service_order s where s.id=sc.service_order_id and s.id=? and s.status='SCHEDULED' and sc.result_status in ('PLANNED','BLOCKED')",
            message==null?"Не удалось выполнить передачу; проверьте заявку":message.substring(0,Math.min(message.length(),1000)),id);
    }
    private ApiException conflict(String message) { return new ApiException(HttpStatus.CONFLICT,"OWNERSHIP_SCHEDULE_CONFLICT",message); }
}
