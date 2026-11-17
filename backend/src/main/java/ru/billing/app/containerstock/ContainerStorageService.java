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
    public void onHistory(UUID history, UUID container, UUID order, String type, String newStatus) {
        boolean receiving=type.equals("RECEIVING_ORDER");
        String operation=jdbc.queryForObject("select operation_type from container_owner_history_view where id=?",String.class,history);
        UUID area=type.equals("SERVICE_ORDER")?null:jdbc.queryForObject(
            "select terminal_area_catalog_id from "+(receiving?"receiving_order":"shipping_order")+" where id=?",UUID.class,order);
        OffsetDateTime at=jdbc.queryForObject("select occurred_at from container_owner_history_view where id=?",OffsetDateTime.class,history);
        var opened=periods("p.container_id=? and p.status='OPEN'",container);
        Period current=opened.size()==1?opened.getFirst():null;
        UUID period=null;
        if(operation.equals("ARRIVAL")) {
            if(!opened.isEmpty()) throw conflict("Для КТК уже есть открытый период хранения. Требуется сверка истории");
            tasks.finished(order,container,true);
            period=UUID.randomUUID();
            jdbc.update("""
                insert into container_storage_period(id,container_id,start_history_id,arrival_history_id,
                    status)
                values(?,?,?,?,'OPEN')
                """,period,container,history,history);
        } else if(operation.equals("OWNER_CHANGE")) {
            OffsetDateTime latest=jdbc.queryForObject("select max(occurred_at) from container_owner_history_view where container_id=? and id<>?",
                OffsetDateTime.class,container,history);
            if(latest!=null && at.isBefore(latest)) throw conflict("Смена собственника не может быть раньше предыдущих операций КТК");
            if(Set.of("ON_TERMINAL","RESERVED_OUT").contains(newStatus)) {
                if(current==null) throw conflict("Не найден однозначный открытый период для смены собственника");
                requireSequence(current,at);
                area=current.area();
                jdbc.update("""
                    update container_storage_period set end_history_id=?,status='CLOSED',
                        updated_at=billing_now() where id=?
                    """,history,current.id());
                period=UUID.randomUUID();
                jdbc.update("""
                    insert into container_storage_period(id,container_id,start_history_id,arrival_history_id,
                        status)
                    select ?,container_id,?,arrival_history_id,'OPEN' from container_storage_period where id=?
                    """,period,history,current.id());
            } else if(!opened.isEmpty()) throw conflict("Состояние КТК не согласовано с открытым периодом хранения");
        } else if(operation.equals("DEPARTURE")) {
            tasks.finished(order,container,false);
            requireOpen(current,area);
            requireSequence(current,at);
            period=current.id();
            jdbc.update("""
                update container_storage_period set end_history_id=?,status='CLOSED',
                    updated_at=billing_now() where id=?
                """,history,period);
        } else if(operation.equals("CANCEL_ARRIVAL")) {
            requireOpen(current,area);
            if(!order.equals(current.receiving())) throw conflict("Открытый период относится к другой поставке");
            period=current.id();
            requireSequence(current,at);
            // Annul the entire physical visit, retaining ownership boundaries and their history.
            jdbc.update("""
                update container_storage_period set status='CANCELLED',updated_at=billing_now()
                  where arrival_history_id=(select arrival_history_id from container_storage_period where id=?)
                """,period);
        } else if(operation.equals("CANCEL_DEPARTURE")) {
            var closed=periods("p.container_id=? and p.end_history_id in (select id from container_owner_history_view where order_id=? and order_type='SHIPPING_ORDER' and operation_type='DEPARTURE') and p.status='CLOSED'",container,order);
            if(closed.size()!=1 || !opened.isEmpty())
                throw conflict("Нельзя открыть период отменяемого вывоза. Сначала отмените последующие операции или проверьте историю");
            current=closed.getFirst();period=current.id();
            requireSequence(current,at);
            Integer laterOwnerChanges=jdbc.queryForObject("""
                select count(*) from container_owner_history_view h
                join container_storage_period p on p.id=?
                join container_owner_history_view departure on departure.id=p.end_history_id
                where h.container_id=p.container_id and h.operation_type='OWNER_CHANGE'
                  and h.storage_period_id is null and h.created_at>=departure.created_at
                """,Integer.class,period);
            if(laterOwnerChanges!=null && laterOwnerChanges>0)
                throw conflict("Нельзя отменить вывоз после смены собственника вне площадки");
            jdbc.update("""
                update container_storage_period set end_history_id=null,status='OPEN',
                    updated_at=billing_now() where id=?
                """,period);
        } else {
            if(current!=null && !operation.equals("RESERVE_RECEIVING") && !operation.equals("CANCEL_RECEIVING_RESERVATION")) {
                period=current.id();
                if(area==null) area=current.area();
            }

        }
        jdbc.update("""
            update container_owner_history set occurred_at=?,time_source='MANUAL_COMPLETION',terminal_area_id=?,
              storage_period_id=? where id=?
            """,at,area,period,history);
    }

    private void requireSequence(Period period,OffsetDateTime at) {
        OffsetDateTime latest=jdbc.queryForObject("""
            select greatest(a.occurred_at,z.occurred_at,(select max(h.occurred_at)
              from container_owner_history_view h where h.storage_period_id=p.id))
            from container_storage_period p join container_owner_history_view a on a.id=p.start_history_id
            left join container_owner_history_view z on z.id=p.end_history_id where p.id=?
            """,OffsetDateTime.class,period.id());
        if(at.isBefore(latest)) throw conflict("Операция не может быть раньше начала периода или последней операции хранения");
    }

    private void requireOpen(Period p,UUID area) {
        if(p==null || !Objects.equals(p.area(),area))
            throw conflict("Не найден однозначный открытый период КТК на этой площадке. Требуется сверка истории хранения");
    }
    private List<Period> periods(String condition,Object... args) {
        return jdbc.query("select p.*,r.id receiving_order_id,r.terminal_area_catalog_id,h.occurred_at from container_storage_period p "
            +"join receiving_order r on r.id=storage_receiving_order(p.id) join container_owner_history_view h on h.id=p.start_history_id "
            +"where "+condition+" for update of p",(rs,n)->new Period(
            rs.getObject("id",UUID.class),rs.getObject("terminal_area_catalog_id",UUID.class),rs.getObject("receiving_order_id",UUID.class),
            rs.getObject("occurred_at",OffsetDateTime.class),rs.getString("status")),args);
    }
    private ApiException conflict(String message) {return new ApiException(HttpStatus.CONFLICT,"STORAGE_PERIOD_CONFLICT",message);}
}
