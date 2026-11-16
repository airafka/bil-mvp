package ru.billing.app.containerstock;

import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.error.ApiException;

/** Called with the physical container locked, inside its stock/order transaction. */
@Service
public class ContainerStorageService {
    private final JdbcTemplate jdbc;
    private final ContainerTaskRows tasks;
    public ContainerStorageService(JdbcTemplate jdbc, ContainerTaskRows tasks) { this.jdbc=jdbc; this.tasks=tasks; }
    record Period(UUID id, UUID area, UUID receiving, OffsetDateTime arrival, String status) {}

    @Transactional(propagation=Propagation.MANDATORY)
    public void onHistory(UUID history, UUID container, UUID order, String type, String oldStatus,
                          String newStatus, UUID owner, boolean cancellation) {
        boolean receiving=type.equals("RECEIVING_ORDER");
        String operation;
        if (type.equals("SERVICE_ORDER")) operation="OWNER_CHANGE";
        else if(cancellation) operation=receiving
            ? ("ON_TERMINAL".equals(oldStatus)?"CANCEL_ARRIVAL":"CANCEL_RECEIVING_RESERVATION")
            : ("DEPARTED".equals(oldStatus)?"CANCEL_DEPARTURE":"CANCEL_SHIPPING_RESERVATION");
        else operation=receiving ? (newStatus.equals("EXPECTED")?"RESERVE_RECEIVING":"ARRIVAL")
            : (newStatus.equals("RESERVED_OUT")?"RESERVE_SHIPPING":"DEPARTURE");
        UUID area=type.equals("SERVICE_ORDER")?null:jdbc.queryForObject(
            "select terminal_area_catalog_id from "+(receiving?"receiving_order":"shipping_order")+" where id=?",UUID.class,order);
        OffsetDateTime at=jdbc.queryForObject("select created_at at time zone 'UTC' from container_owner_history where id=?",OffsetDateTime.class,history);
        var opened=periods("container_id=? and status='OPEN'",container);
        Period current=opened.size()==1?opened.getFirst():null;
        UUID period=null;
        if(operation.equals("ARRIVAL")) {
            if(!opened.isEmpty()) throw conflict("Для КТК уже есть открытый период хранения. Требуется сверка истории");
            var source=tasks.finished(order,container,true);
            UUID autoRow=source.table().equals("receiving_order_container")?source.id():null;
            UUID waybillRow=source.table().equals("waybill_container")?source.id():null;
            period=UUID.randomUUID();
            jdbc.update("""
                insert into container_storage_period(id,container_id,terminal_area_id,receiving_order_id,receiving_history_id,
                    receiving_at,receiving_client_id,receiving_owner_id,status,receiving_order_container_id,waybill_container_id)
                select ?,?,?,id,?,?,client_id,?,'OPEN',?,? from receiving_order where id=?
                """,period,container,area,history,at,owner,autoRow,waybillRow,order);
            snapshotEmpty(period);
        } else if(operation.equals("DEPARTURE")) {
            var source=tasks.finished(order,container,false);
            requireOpen(current,area);
            if(at.isBefore(current.arrival())) throw conflict("Вывоз не может быть раньше приёма КТК");
            period=current.id();
            jdbc.update("""
                update container_storage_period set shipping_history_id=?,shipping_at=?,shipping_order_container_id=?,status='CLOSED',
                    updated_at=billing_now() where id=?
                """,history,at,source.id(),period);
        } else if(operation.equals("CANCEL_ARRIVAL")) {
            requireOpen(current,area);
            if(!order.equals(current.receiving())) throw conflict("Открытый период относится к другой поставке");
            period=current.id();
            jdbc.update("update container_storage_period set status='CANCELLED',updated_at=billing_now() where id=?",period);
        } else if(operation.equals("CANCEL_DEPARTURE")) {
            var closed=periods("container_id=? and shipping_order_container_id in (select id from shipping_order_container where shipping_order_id=?) and status='CLOSED'",container,order);
            if(closed.size()!=1 || !opened.isEmpty())
                throw conflict("Нельзя открыть период отменяемого вывоза. Сначала отмените последующие операции или проверьте историю");
            current=closed.getFirst();period=current.id();
            jdbc.update("""
                update container_storage_period set shipping_history_id=null,shipping_at=null,shipping_order_container_id=null,status='OPEN',
                    updated_at=billing_now() where id=?
                """,period);
        } else {
            if(current!=null && !operation.equals("RESERVE_RECEIVING") && !operation.equals("CANCEL_RECEIVING_RESERVATION")) {
                period=current.id();
                if(area==null) area=current.area();
            }

        }
        jdbc.update("""
            update container_owner_history set operation_type=?,occurred_at=?,time_source='MANUAL_COMPLETION',terminal_area_id=?,
              storage_period_id=?,cancellation=? where id=?
            """,operation,at,area,period,cancellation,history);
    }

    private void requireOpen(Period p,UUID area) {
        if(p==null || !Objects.equals(p.area(),area))
            throw conflict("Не найден однозначный открытый период КТК на этой площадке. Требуется сверка истории хранения");
    }
    private List<Period> periods(String condition,Object... args) {
        return jdbc.query("select * from container_storage_period where "+condition+" for update",(rs,n)->new Period(
            rs.getObject("id",UUID.class),rs.getObject("terminal_area_id",UUID.class),rs.getObject("receiving_order_id",UUID.class),
            rs.getObject("receiving_at",OffsetDateTime.class),rs.getString("status")),args);
    }
    private void snapshotEmpty(UUID period) {
        jdbc.update("""
            update container_storage_period p set is_empty=case
              when p.receiving_order_container_id is not null then
                (select rc.empty from receiving_order_container rc where rc.id=p.receiving_order_container_id)
              else (select wc.net_weight=0 from waybill_container wc where wc.id=p.waybill_container_id)
              end where p.id=?
            """,period);
    }
    private ApiException conflict(String message) {return new ApiException(HttpStatus.CONFLICT,"STORAGE_PERIOD_CONFLICT",message);}
}
