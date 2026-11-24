package ru.billing.app.containerstock;

import java.util.*;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.error.ApiException;
import ru.billing.app.order.ContainerType;
import ru.billing.app.order.PagedResponse;

@Service
public class ContainerStockService {
    private final JdbcTemplate jdbc;
    private final ContainerStorageService storage;
    private final ContainerTaskRows tasks;
    public ContainerStockService(JdbcTemplate jdbc, ContainerStorageService storage, ContainerTaskRows tasks) { this.jdbc=jdbc; this.storage=storage; this.tasks=tasks; }
    public record Owner(UUID id, UUID containerId, String containerName, String containerType,
            UUID clientId, String clientName, String status, UUID receivingOrderId, UUID shippingOrderId) {}
    public record Lookup(UUID containerId, UUID ownerClientId, String ownerClientName, String status) {}
    @Transactional(readOnly=true)
    public List<Lookup> lookup(List<UUID> containerIds) {
        var ids = containerIds.stream().distinct().toList();
        String placeholders = String.join(",", Collections.nCopies(ids.size(), "?"));
        var result = jdbc.query("select c.id, o.client_id, cl.name, coalesce(o.status,'DEPARTED') from container c "
            + "left join container_owner_current o on o.container_id=c.id left join client cl on cl.id=o.client_id "
            + "where c.id in (" + placeholders + ") order by c.code",
            (rs,n) -> new Lookup(rs.getObject(1,UUID.class), rs.getObject(2,UUID.class), rs.getString(3), rs.getString(4)), ids.toArray());
        if (result.size()!=ids.size()) throw new ApiException(HttpStatus.NOT_FOUND,"CONTAINER_NOT_FOUND","КТК не найден");
        return result;
    }
    public record History(UUID id, UUID containerId, UUID oldClientId, String oldClientName,
            UUID newClientId, String newClientName, String oldStatus, String newStatus,
            UUID orderId, String orderType, Long orderNumber, Instant createdAt, boolean cancellation, String operationType, java.time.OffsetDateTime occurredAt,
            UUID containerPeriodId, UUID previousContainerPeriodId) {}
    record State(UUID id, UUID client, String status, UUID receiving, UUID shipping) {}
    record Reservation(UUID container, UUID previousOwner) {}

    public void lockContainers(Collection<UUID> ids) {
        var locked=ContainerLocks.lock(jdbc,ids);
        for(UUID id:locked) {
            if(Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from container_owner_history where container_id=? and order_type<>'SERVICE_ORDER' and (occurred_at at time zone 'Europe/Moscow')::date>billing_today())",Boolean.class,id)))
                throw error("STOCK_DATE_BEFORE_HISTORY","Рабочая дата раньше складских операций КТК. Проверьте календарь");
        }
        ContainerLocks.refreshLockedOwners(jdbc,locked);
    }
    State state(UUID id) {
        var rows=jdbc.query("select id,client_id,status,receiving_order_id,shipping_order_id from container_owner where container_id=?",(rs,n)->new State(
            rs.getObject("id",UUID.class),rs.getObject("client_id",UUID.class),rs.getString("status"),
            rs.getObject("receiving_order_id",UUID.class),rs.getObject("shipping_order_id",UUID.class)),id);
        return rows.isEmpty()?null:rows.getFirst();
    }
    UUID transition(UUID container, UUID client, String status, UUID receiving, UUID shipping, UUID order, String type) {
        return transition(container,client,status,receiving,shipping,order,type,null);
    }
    UUID transition(UUID container, UUID client, String status, UUID receiving, UUID shipping, UUID order, String type,java.time.OffsetDateTime effectiveAt) {
        State old=state(container);
        if(old==null) jdbc.update("insert into container_owner(id,container_id,client_id,status,shipping_order_id) values(?,?,?,?,?)",
            UUID.randomUUID(),container,client,status,shipping);
        else jdbc.update("update container_owner set client_id=?,status=?,shipping_order_id=?,version=version+1,updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",
            client,status,shipping,old.id());
        // Only drafts follow the register. Confirmation freezes the shipment owner.
        jdbc.update("""
            update shipping_order_container sc set owner_container_id=?
            from shipping_order s where s.id=sc.shipping_order_id and s.order_status='DRAFT'
                and sc.container_id=?
            """,client,container);
        if(old==null || !Objects.equals(old.client(),client) || !Objects.equals(old.status(),status)) {
            UUID history=UUID.randomUUID();
            jdbc.update("insert into container_owner_history(id,container_id,old_client_id,new_client_id,old_status,new_status,order_id,order_type,occurred_at) values(?,?,?,?,?,?,?,?,coalesce(?::timestamptz,billing_now()))",
                history,container,old==null?null:old.client(),client,old==null?null:old.status(),status,order,type,effectiveAt);
            storage.onHistory(history,container,order,type,status);
            return history;
        }
        return null;
    }
    public void reserve(String resource, UUID order) {
        boolean receiving=resource.equals("receiving-orders");
        var rows=tasks.rowsForStockOperation(order,receiving);
        var containerIds = rows.stream().map(ContainerTaskRows.Row::container).toList();
        lockContainers(containerIds);
        var conflicts = new StockViolations();
        for (var row : rows) {
            var old = state(row.container());
            var problem = ContainerStockPolicy.reservationViolation(receiving, old == null ? null : old.status());
            if (problem != null) addViolation(conflicts, row.code(), old, problem);
        }
        if (!conflicts.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "CONTAINER_RESERVATION_CONFLICT",
                conflicts.detail(), conflicts.originalMessage());
        if (!receiving) requireNoPlannedOwnershipTransfers(containerIds, "");
        for(var row:rows) {
            tasks.change(row,null,"UPLOADED");
            State old=state(row.container());
            if(receiving) transition(row.container(),row.owner(),"EXPECTED",order,old == null ? null : old.shipping(),order,"RECEIVING_ORDER");
            else {
                jdbc.update("update shipping_order_container set owner_container_id=? where id=?",old.client(),row.id());
                transition(row.container(),old.client(),"RESERVED_OUT",old.receiving(),order,order,"SHIPPING_ORDER");
            }
        }
    }

    /** Caller holds the physical container locks. */
    void requireNoPlannedOwnershipTransfers(Collection<UUID> lockedContainerIds, String recoveryHint) {
        requireNoPlannedOwnershipTransfers(lockedContainerIds, recoveryHint, false);
    }

    void requireNoDueOwnershipTransfers(Collection<UUID> lockedContainerIds) {
        requireNoPlannedOwnershipTransfers(lockedContainerIds, "", true);
    }

    private void requireNoPlannedOwnershipTransfers(Collection<UUID> lockedContainerIds, String recoveryHint, boolean dueOnly) {
        if (lockedContainerIds.isEmpty()) return;
        String placeholders = String.join(",", Collections.nCopies(lockedContainerIds.size(), "?"));
        var conflicts = jdbc.query("""
                select s.number, string_agg(c.code, ', ' order by c.code) as container_codes
                from service_order_container sc
                join service_order s on s.id = sc.service_order_id
                join container c on c.id = sc.container_id
                where s.status = 'SCHEDULED' and sc.result_status = 'PLANNED'
                  and sc.container_id in (%s) %s
                group by s.id, s.number order by s.number
                """.formatted(placeholders, dueOnly ? "and sc.plan_at < ((billing_today()+1)::timestamp at time zone 'Europe/Moscow')" : ""),
                (rs, n) -> "По КТК " + rs.getString("container_codes")
                        + " ожидает выполнения заявка на смену собственника №" + rs.getLong("number") + ".",
                lockedContainerIds.toArray());
        if (!conflicts.isEmpty()) {
            String reason = String.join(" ", conflicts);
            throw error("OWNERSHIP_TRANSFER_PLANNED", recoveryHint.isEmpty() ? reason : reason + " " + recoveryHint);
        }
    }

    public void verifyFinished(String resource,UUID order,UUID containerId){
        tasks.finished(order,containerId,resource.equals("receiving-orders"));
    }

    /** Caller holds the document lock. The manual button delivers all outstanding row results. */
    public boolean finishContainers(String resource,UUID order,UUID containerId,java.time.OffsetDateTime eventTime){
        boolean receiving=resource.equals("receiving-orders");
        var rows=tasks.rowsForStockOperation(order,receiving);
        if(containerId!=null && rows.stream().noneMatch(r->r.container().equals(containerId)))
            throw error("CONTAINER_NOT_IN_ORDER","КТК отсутствует в этой заявке");
        var outstanding=rows.stream().filter(r->!"FINISHED".equals(r.status())).toList();
        var selected=outstanding.stream().filter(r->containerId==null || r.container().equals(containerId)).toList();
        var selectedIds = selected.stream().map(ContainerTaskRows.Row::container).toList();
        if (eventTime == null) lockContainers(selectedIds);
        else ContainerLocks.lockCurrentOwners(jdbc,selectedIds);
        requireNoDueOwnershipTransfers(selectedIds);
        for(var row:selected) applyFinishedResult(order,receiving,row,eventTime);
        // Read the persisted results while the order is locked. Empty legacy documents can be completed manually.
        return allTasksFinished(order,receiving);
    }

    public boolean allTasksFinished(UUID order, boolean receiving) {
        return tasks.rows(order,receiving).stream().allMatch(row -> "FINISHED".equals(row.status()));
    }

    private void applyFinishedResult(UUID order,boolean receiving,ContainerTaskRows.Row row,java.time.OffsetDateTime eventTime){
        State old=state(row.container());
        if(receiving && (old==null || !"EXPECTED".equals(old.status()) || !order.equals(old.receiving())))
            throw error("RECEIVING_RESERVATION_REQUIRED",describe(row.container(),old,"КТК не зарезервирован этой поставкой"));
        if(!receiving && (old==null || !"RESERVED_OUT".equals(old.status()) || !order.equals(old.shipping())))
            throw error("SHIPPING_RESERVATION_REQUIRED",describe(row.container(),old,"КТК не зарезервирован этим вывозом"));
        if (eventTime != null && Boolean.TRUE.equals(jdbc.queryForObject("""
                select exists(select 1 from container_owner_history where container_id=? and occurred_at>?)
                """,Boolean.class,row.container(),eventTime)))
            throw error("TOS_EVENT_OUT_OF_SEQUENCE","Время операции раньше предыдущего события КТК");
        tasks.change(row,"UPLOADED","FINISHED");
        if(receiving) transition(row.container(),old.client(),"ON_TERMINAL",order,old.shipping(),order,"RECEIVING_ORDER",eventTime);
        else transition(row.container(),old.client(),"DEPARTED",old.receiving(),order,order,"SHIPPING_ORDER",eventTime);
    }
    private void addViolation(StockViolations conflicts, String code, State state, ContainerStockPolicy.Violation problem) {
        var related = problem.relatedOrder();
        UUID document = state == null ? null : switch (related) {
            case RECEIVING -> state.receiving();
            case SHIPPING -> state.shipping();
            case NONE -> null;
        };
        String detail = problem.description("КТК");
        Integer number = null;
        if (document != null) {
            boolean shipping = related == ContainerStockPolicy.RelatedOrder.SHIPPING;
            String table = shipping ? "shipping_order" : "receiving_order";
            number = jdbc.queryForObject("select number from " + table + " where id=?", Integer.class, document);
            detail += " (" + (shipping ? "вывоз" : "поставка") + " №" + number + ")";
        }
        conflicts.add(problem.key("ContainerStatus"), number, code, detail);
    }

    private String containerName(UUID id) {
        return jdbc.queryForObject("select code from container where id=?",String.class,id);
    }
    private String describe(UUID id, State state, String problem) {
        UUID related=state==null?null:("RESERVED_OUT".equals(state.status())||"DEPARTED".equals(state.status())?state.shipping():state.receiving());
        boolean shipping=state!=null&&("RESERVED_OUT".equals(state.status())||"DEPARTED".equals(state.status()));
        var number=related==null?List.<Integer>of():jdbc.query("select number from "+(shipping?"shipping_order":"receiving_order")+" where id=?",(rs,n)->rs.getInt(1),related);
        return containerName(id)+": "+problem+(number.isEmpty()?"":" ("+(shipping?"вывоз":"поставка")+" №"+number.getFirst()+")");
    }
    public void cancel(String resource,UUID order,String previousStatus) {
        if("DRAFT".equals(previousStatus))return;
        boolean receiving=resource.equals("receiving-orders");
        String type=receiving?"RECEIVING_ORDER":"SHIPPING_ORDER";
        var rows=tasks.rows(order,receiving);
        var ids=rows.stream().map(ContainerTaskRows.Row::container).toList();
        lockContainers(ids);
        requireNoDueOwnershipTransfers(ids);
        var reservations=jdbc.query("""
            select container_id,old_client_id from container_owner_history_view
            where order_id=? and order_type=? and operation_type=? and not cancellation and new_status=?
            """,(rs,n)->new Reservation(rs.getObject("container_id",UUID.class),rs.getObject("old_client_id",UUID.class)),
            order,type,receiving?"RESERVE_RECEIVING":"RESERVE_SHIPPING",receiving?"EXPECTED":"RESERVED_OUT");
        var previousOwners=new HashMap<UUID,UUID>();
        for(var reservation:reservations) {
            if(previousOwners.containsKey(reservation.container())) throw error("STOCK_HISTORY_REQUIRED","Неоднозначная история резервирования КТК");
            previousOwners.put(reservation.container(),reservation.previousOwner());
        }
        if(!previousOwners.keySet().equals(new HashSet<>(ids)))
            throw error("STOCK_HISTORY_REQUIRED","Состав заявки не совпадает с историей резервирования. Требуется сверка остатков");
        var conflicts = new StockViolations();
        var pendingConflicts = new ArrayList<String>();
        for(var row:rows) {
            UUID id=row.container();
            boolean finished="FINISHED".equals(row.status());
            if(!finished && (!"UPLOADED".equals(row.status()) || "COMPLETED".equals(previousStatus)))
                throw error("CONTAINER_TASK_STATUS_CHANGED","Статус строки КТК не соответствует отменяемой операции");
            State old=state(id);
            UUID currentOrder = old == null ? null : (receiving ? old.receiving() : old.shipping());
            String status = old == null ? null : old.status();
            if (finished) {
                var problem = ContainerStockPolicy.completedCancellationViolation(receiving, status, currentOrder, order);
                if (problem != null) addViolation(conflicts, row.code(), old, problem);
            } else if (!ContainerStockPolicy.canCancel(receiving, false, status, currentOrder, order)) {
                pendingConflicts.add(describe(id,old,"отмена невозможна: КТК уже участвует в другой операции; сначала отмените последующие заявки"));
            }
        }
        if (!conflicts.isEmpty()) {
            pendingConflicts.addFirst(conflicts.detail());
            throw new ApiException(HttpStatus.BAD_REQUEST, "CANCELLATION_STOCK_CONFLICT", String.join("; ", pendingConflicts), conflicts.originalMessage());
        }
        if (!pendingConflicts.isEmpty()) throw error("CANCELLATION_STOCK_CONFLICT", String.join("; ", pendingConflicts));
        for(UUID id:ids) {
            State old=state(id);
            UUID previousOrder;
            try { previousOrder=jdbc.queryForObject("select previous_stock_order(?,?,?)",UUID.class,id,order,type); }
            catch(org.springframework.dao.DataIntegrityViolationException exception) {
                throw error("STOCK_HISTORY_REQUIRED","Неоднозначный порядок истории резервирования. Требуется сверка остатков");
            }
            // Receiving restores the owner before acceptance. Shipping preserves any later owner change.
            UUID previousOwner=previousOwners.get(id);
            transition(id,receiving&&previousOwner!=null?previousOwner:old.client(),receiving?"DEPARTED":"ON_TERMINAL",
                receiving?previousOrder:old.receiving(),receiving?old.shipping():previousOrder,order,type);
        }
        for(var row:rows) tasks.change(row,row.status(),null);
    }
    static final String OWNER_SELECT="""
        select o.*,c.code as container_name,c.container_type,cl.name as client_name
        from container_owner_current o join container c on c.id=o.container_id left join client cl on cl.id=o.client_id
        """;
    Owner owner(java.sql.ResultSet rs)throws java.sql.SQLException {
        return new Owner(rs.getObject("id",UUID.class),rs.getObject("container_id",UUID.class),rs.getString("container_name"),
            rs.getString("container_type"),rs.getObject("client_id",UUID.class),rs.getString("client_name"),rs.getString("status"),
            rs.getObject("receiving_order_id",UUID.class),rs.getObject("shipping_order_id",UUID.class));
    }
    @Transactional(readOnly=true)
    public PagedResponse<Owner> page(String query, UUID client, String status, ContainerType containerType, boolean remains, int page, int size) {
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        if(status!=null&&!Set.of("EXPECTED","ON_TERMINAL","RESERVED_OUT","DEPARTED").contains(status))throw error("INVALID_CONTAINER_STATUS","Неизвестный статус КТК");
        String filter=" where (?='' or position(lower(?) in lower(concat_ws(' ',c.code,cl.name)))>0) and (?::uuid is null or o.client_id=?) and (?::text is null or o.status=?) and (not ? or o.status in ('ON_TERMINAL','RESERVED_OUT'))";
        filter += " and (?::text is null or c.container_type=?)";
        String type = containerType == null ? null : containerType.name();
        Object[] args={query,query,client,client,status,status,remains,type,type};
        long count=jdbc.queryForObject("select count(*) from ("+OWNER_SELECT+filter+") q",Long.class,args);
        var params=new ArrayList<>(Arrays.asList(args));params.add(size);params.add(page*size);
        return PagedResponse.of(jdbc.query(OWNER_SELECT+filter+" order by c.code,o.id limit ? offset ?",(rs,n)->owner(rs),params.toArray()),page,size,count);
    }
    @Transactional(readOnly=true)
    public List<History> history(UUID container, boolean all) {
        if(jdbc.queryForObject("select count(*) from container where id=?",Integer.class,container)==0)throw error("CONTAINER_NOT_FOUND","КТК не найден");
        return jdbc.query("""
            select h.*,old.name as old_name,new.name as new_name,
                coalesce(r.number,s.number,so.number) as order_number,
                (select p.id from container_storage_period p where p.end_history_id=h.id
                  and h.operation_type='OWNER_CHANGE') as previous_container_period_id
            from container_owner_history_timeline h left join client old on old.id=h.timeline_old_client_id
            left join client new on new.id=h.new_client_id
            left join receiving_order r on h.order_type='RECEIVING_ORDER' and r.id=h.order_id
            left join shipping_order s on h.order_type='SHIPPING_ORDER' and s.id=h.order_id
            left join service_order_current so on h.order_type='SERVICE_ORDER' and so.id=h.order_id
            where h.container_id=? and (? or (h.occurred_at at time zone 'Europe/Moscow')::date<=billing_today()) and (? or ((h.order_type='SERVICE_ORDER' or h.new_status in ('ON_TERMINAL','DEPARTED'))
                and (h.order_type in ('RECEIVING_ORDER','SHIPPING_ORDER') or so.status = 'DONE')))
            order by h.created_at desc,h.id desc
            """,(rs,n)->new History(rs.getObject("id",UUID.class),container,rs.getObject("timeline_old_client_id",UUID.class),rs.getString("old_name"),
                rs.getObject("new_client_id",UUID.class),rs.getString("new_name"),rs.getString("old_status"),rs.getString("new_status"),
                rs.getObject("order_id",UUID.class),rs.getString("order_type"),rs.getObject("order_number",Long.class),rs.getObject("created_at",LocalDateTime.class).toInstant(ZoneOffset.UTC),rs.getBoolean("cancellation"),rs.getString("operation_type"),rs.getObject("occurred_at",java.time.OffsetDateTime.class),
                rs.getObject("container_period_id",UUID.class),rs.getObject("previous_container_period_id",UUID.class)),container,all,all);
    }
    ApiException error(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
