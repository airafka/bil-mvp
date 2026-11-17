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
        OffsetDateTime at=jdbc.queryForObject("select occurred_at from container_owner_history where id=?",OffsetDateTime.class,history);
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
        } else if(operation.equals("OWNER_CHANGE")) {
            OffsetDateTime latest=jdbc.queryForObject("select max(occurred_at) from container_owner_history where container_id=? and id<>?",
                OffsetDateTime.class,container,history);
            if(latest!=null && at.isBefore(latest)) throw conflict("Смена собственника не может быть раньше предыдущих операций КТК");
            if(Set.of("ON_TERMINAL","RESERVED_OUT").contains(newStatus)) {
                if(current==null) throw conflict("Не найден однозначный открытый период для смены собственника");
                requireSequence(current,at);
                area=current.area();
                jdbc.update("""
                    update container_storage_period set shipping_history_id=?,shipping_at=?,status='CLOSED',
                        updated_at=billing_now() where id=?
                    """,history,at,current.id());
                period=UUID.randomUUID();
                jdbc.update("""
                    insert into container_storage_period(id,container_id,terminal_area_id,receiving_order_id,receiving_history_id,
                        receiving_at,receiving_client_id,receiving_owner_id,is_empty,status,receiving_order_container_id,waybill_container_id)
                    select ?,container_id,terminal_area_id,receiving_order_id,?,?,receiving_client_id,?,is_empty,'OPEN',
                        receiving_order_container_id,waybill_container_id from container_storage_period where id=?
                    """,period,history,at,owner,current.id());
            } else if(!opened.isEmpty()) throw conflict("Состояние КТК не согласовано с открытым периодом хранения");
        } else if(operation.equals("DEPARTURE")) {
            var source=tasks.finished(order,container,false);
            requireOpen(current,area);
            requireSequence(current,at);
            period=current.id();
            jdbc.update("""
                update container_storage_period set shipping_history_id=?,shipping_at=?,shipping_order_container_id=?,status='CLOSED',
                    updated_at=billing_now() where id=?
                """,history,at,source.id(),period);
        } else if(operation.equals("CANCEL_ARRIVAL")) {
            requireOpen(current,area);
            if(!order.equals(current.receiving())) throw conflict("Открытый период относится к другой поставке");
            period=current.id();
            requireSequence(current,at);
            // Annul the entire physical visit, retaining ownership boundaries and their history.
            jdbc.update("""
                with recursive chain as (
                  select id,receiving_history_id from container_storage_period where id=?
                  union
                  select p.id,p.receiving_history_id from container_storage_period p
                  join chain c on p.shipping_history_id=c.receiving_history_id
                  join container_owner_history h on h.id=c.receiving_history_id and h.operation_type='OWNER_CHANGE'
                ) update container_storage_period set status='CANCELLED',updated_at=billing_now()
                  where id in (select id from chain)
                """,period);
        } else if(operation.equals("CANCEL_DEPARTURE")) {
            var closed=periods("container_id=? and shipping_order_container_id in (select id from shipping_order_container where shipping_order_id=?) and status='CLOSED'",container,order);
            if(closed.size()!=1 || !opened.isEmpty())
                throw conflict("Нельзя открыть период отменяемого вывоза. Сначала отмените последующие операции или проверьте историю");
            current=closed.getFirst();period=current.id();
            requireSequence(current,at);
            Integer laterOwnerChanges=jdbc.queryForObject("""
                select count(*) from container_owner_history h
                join container_storage_period p on p.id=?
                join container_owner_history departure on departure.id=p.shipping_history_id
                where h.container_id=p.container_id and h.operation_type='OWNER_CHANGE'
                  and h.storage_period_id is null and h.created_at>=departure.created_at
                """,Integer.class,period);
            if(laterOwnerChanges!=null && laterOwnerChanges>0)
                throw conflict("Нельзя отменить вывоз после смены собственника вне площадки");
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

    private void requireSequence(Period period,OffsetDateTime at) {
        OffsetDateTime latest=jdbc.queryForObject("""
            select greatest(p.receiving_at,p.shipping_at,(select max(h.occurred_at)
              from container_owner_history h where h.storage_period_id=p.id))
            from container_storage_period p where p.id=?
            """,OffsetDateTime.class,period.id());
        if(at.isBefore(latest)) throw conflict("Операция не может быть раньше начала периода или последней операции хранения");
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
