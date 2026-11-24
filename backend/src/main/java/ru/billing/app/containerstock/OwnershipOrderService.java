package ru.billing.app.containerstock;

import java.util.*;
import java.time.OffsetDateTime;
import java.time.LocalDate;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;
import ru.billing.app.order.PagedResponse;
import jakarta.validation.constraints.*;

@Service
public class OwnershipOrderService {
    private final JdbcTemplate jdbc;
    private final ContainerStockService stock;
    public OwnershipOrderService(JdbcTemplate jdbc,ContainerStockService stock){this.jdbc=jdbc;this.stock=stock;}
    public enum ServiceType { CHANGE_OWNER }
    public record Create(@NotNull UUID clientId,@NotNull ServiceType service,@Size(max=1000)String comment,List<@NotNull UUID> containerOwnerIds,LocalDate effectiveDate,UUID sourceClientId) {}
    public record Update(@NotNull UUID id,@NotNull ServiceType service,@Size(max=1000)String comment,LocalDate effectiveDate,
            UUID clientId,List<@NotNull UUID> containerOwnerIds) {}
    public record Selection(UUID id,UUID containerOwnerId) {}
    public record Link(UUID id,UUID containerOwnerId,UUID containerId,String containerName,String containerType,
            UUID clientId,String clientName,String status,UUID containerVisitId,UUID expectedClientId,String resultStatus,String resultReason) {}
    public record Header(UUID id,long number,UUID clientId,String clientName,String service,String comment,
            String status,OffsetDateTime completionAt,long containerQuantity,LocalDate effectiveDate,UUID sourceClientId,String sourceClientName,
            String executionError,boolean exportQueued,OffsetDateTime exportSentAt,String exportError,UUID outboundDataId,boolean exportExhausted) {}
    public record Details(Header order,List<Link> containers) {}
    private static final String HEADER="""
        select s.*,e.id as outbound_data_id,e.id is not null as export_queued,(e.success is false and e.attempts>=5) as export_exhausted,
               case when e.success then e.updated_at at time zone 'UTC' end as sent_at,e.error_message,s.completion_at at time zone 'UTC' as confirmation_instant,c.name as client_name,src.name as source_client_name,(select count(*) from service_order_container_current sc where sc.service_order_id=s.id) as quantity
        from service_order_current s join client c on c.id=s.client_id
        left join client src on src.id=s.source_client_id
        left join outbound_data e on e.root_object_id=s.id and e.entity_type='SERVICE_ORDER' and e.message_type='SERVICE_ORDER_CHAIN_PACKAGE'
        """;
    private Header header(java.sql.ResultSet rs)throws java.sql.SQLException {
        return new Header(rs.getObject("id",UUID.class),rs.getLong("number"),rs.getObject("client_id",UUID.class),rs.getString("client_name"),
            rs.getString("service"),rs.getString("comment"),rs.getString("status"),rs.getObject("confirmation_instant",OffsetDateTime.class),rs.getLong("quantity"),rs.getObject("effective_date",LocalDate.class),
            rs.getObject("source_client_id",UUID.class),rs.getString("source_client_name"),rs.getString("execution_error"),rs.getBoolean("export_queued"),
            rs.getObject("sent_at",OffsetDateTime.class),rs.getString("error_message"),rs.getObject("outbound_data_id",UUID.class),rs.getBoolean("export_exhausted"));
    }
    private Header locked(UUID id){
        var ids=jdbc.query("select id from service_order where id=? for update",(rs,n)->rs.getObject(1,UUID.class),id);
        if(ids.isEmpty())throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND,"SERVICE_ORDER_NOT_FOUND","Заявка на смену собственника не найдена","NotFound");
        return jdbc.queryForObject(HEADER+" where s.id=?",(rs,n)->header(rs),id);
    }
    private void draft(Header h) {
        if (!h.status().equals("DRAFT")) {
            throw ApiException.fromSourceCode(HttpStatus.FORBIDDEN, "SERVICE_ORDER_NOT_DRAFT",
                    "Изменение доступно только для черновика заявки", "AccessDenied");
        }
    }
    private void requireClient(UUID clientId){
        if (!Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from client where id=?)",Boolean.class,clientId)))
            throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND,"CLIENT_NOT_FOUND","Клиент не найден","NotFound");
    }
    private void differentOwners(UUID source,UUID target){
        if (target.equals(source)) throw error(HttpStatus.BAD_REQUEST,"OWNERSHIP_SAME_CLIENT","Прежний и новый собственники должны различаться");
    }
    private LocalDate date(LocalDate value) {
        if(value==null) return jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(value.getYear()<1 || value.getYear()>9999) throw error(HttpStatus.BAD_REQUEST,"INVALID_EFFECTIVE_DATE","Укажите дату передачи с годом от 1 до 9999");
        return value;
    }
    @Transactional(readOnly=true)
    public PagedResponse<Header> page(String query,String status,int page,int size){
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        String filter=" where (?='' or position(lower(?) in lower(concat_ws(' ',s.number::text,c.name,src.name,s.comment)))>0) and (?='' or s.status=?)";
        long count=jdbc.queryForObject("select count(*) from ("+HEADER+filter+") q",Long.class,query,query,status,status);
        return PagedResponse.of(jdbc.query(HEADER+filter+" order by s.number desc limit ? offset ?",(rs,n)->header(rs),query,query,status,status,size,page*size),page,size,count);
    }
    @Transactional public Details create(Create request){
        List<UUID> selection = request.containerOwnerIds() == null ? List.of() : request.containerOwnerIds();
        if (selection.isEmpty() && request.sourceClientId() == null) {
            throw error(HttpStatus.BAD_REQUEST, "SOURCE_CLIENT_REQUIRED", "Укажите прежнего собственника КТК");
        }
        differentOwners(request.sourceClientId(),request.clientId());
        requireClient(request.clientId());
        if (request.sourceClientId()!=null) requireClient(request.sourceClientId());
        UUID id=UUID.randomUUID();
        jdbc.update("insert into service_order(id,client_id,service,comment,effective_date,source_client_id) values(?,?,?,?,?,?)",id,request.clientId(),request.service().name(),request.comment(),date(request.effectiveDate()),request.sourceClientId());
        return selection.isEmpty() ? details(id) : select(id,asSelections(selection));
    }
    private List<Selection> asSelections(List<UUID> ownerIds){
        return ownerIds.stream().map(ownerId -> new Selection(null,ownerId)).toList();
    }
    @Transactional(readOnly=true)public Details details(UUID id){
        var rows=jdbc.query(HEADER+" where s.id=?",(rs,n)->header(rs),id);
        if(rows.isEmpty())throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND,"SERVICE_ORDER_NOT_FOUND","Заявка не найдена","NotFound");
        return new Details(rows.getFirst(),links(id));
    }
    private Link link(java.sql.ResultSet rs)throws java.sql.SQLException {
        return new Link(rs.getObject("link_id",UUID.class),rs.getObject("owner_id",UUID.class),rs.getObject("container_id",UUID.class),
            rs.getString("container_name"),rs.getString("container_type"),rs.getObject("client_id",UUID.class),rs.getString("client_name"),rs.getString("status"),rs.getObject("container_visit_id",UUID.class),
            rs.getObject("expected_client_id",UUID.class),rs.getString("result_status"),rs.getString("result_reason"));
    }
    private List<Link> links(UUID id){
        return jdbc.query("""
            select sc.id as link_id,o.id as owner_id,sc.container_id,c.code as container_name,c.container_type,
                o.client_id,cl.name as client_name,o.status,sc.container_visit_id,sc.expected_client_id,sc.result_status,sc.result_reason
            from service_order_container_current sc join container c on c.id=sc.container_id
            left join container_owner_current o on o.container_id=sc.container_id left join client cl on cl.id=o.client_id
            where sc.service_order_id=? order by c.code
            """,(rs,n)->link(rs),id);
    }
    @Transactional public Details update(UUID id,Update request){
        if(!id.equals(request.id()))throw error(HttpStatus.BAD_REQUEST,"SERVICE_ORDER_ID_MISMATCH","Идентификаторы заявки не совпадают");
        Header h=locked(id);draft(h);
        UUID target=request.clientId()==null?h.clientId():request.clientId();
        LocalDate effective=date(request.effectiveDate()==null?h.effectiveDate():request.effectiveDate());
        differentOwners(h.sourceClientId(),target);
        if (!target.equals(h.clientId())) requireClient(target);
        jdbc.update("update service_order set service=?,comment=?,client_id=?,effective_date=?,updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",
                request.service().name(),request.comment(),target,effective,id);
        if (request.containerOwnerIds()!=null) return select(id,asSelections(request.containerOwnerIds()));
        if (!target.equals(h.clientId()) || !effective.equals(h.effectiveDate())){
            var existing=links(id);
            if (!existing.isEmpty()) validateExisting(locked(id),existing,false);
        }
        return details(id);
    }
    @Transactional public void delete(UUID id){
        draft(locked(id));
        if(Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from container_owner_history where order_type='SERVICE_ORDER' and order_id=?) or exists(select 1 from service_order_container where service_order_id=? and result_status='WITHDRAWN')",Boolean.class,id,id)))
            throw error(HttpStatus.CONFLICT,"SERVICE_ORDER_HAS_HISTORY","Ранее подтверждённая заявка сохраняется для истории; её можно изменить и подтвердить повторно");
        jdbc.update("delete from service_order_container where service_order_id=?",id);jdbc.update("delete from service_order where id=?",id);
    }
    @Transactional(readOnly=true)public PagedResponse<Link> available(UUID id,UUID clientId,LocalDate effectiveDate,String query,int page,int size){
        var h=details(id).order();draft(h);
        return candidates(id,clientId==null?h.clientId():clientId,h.sourceClientId(),date(effectiveDate==null?h.effectiveDate():effectiveDate),query,page,size);
    }
    @Transactional(readOnly=true)public PagedResponse<Link> availableForCreate(UUID clientId,UUID sourceClientId,LocalDate effectiveDate,String query,int page,int size){
        return candidates(null,clientId,sourceClientId,date(effectiveDate),query,page,size);
    }
    private PagedResponse<Link> candidates(UUID id,UUID clientId,UUID sourceClientId,LocalDate effectiveDate,String query,int page,int size){
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        String from="""
            from ownership_transfer_candidates(?::date,?::uuid,?::uuid) candidate
            join container_owner o on o.id=candidate.owner_id join container c on c.id=o.container_id
            join client cl on cl.id=candidate.previous_client_id
            left join service_order_container_current sc on sc.container_id=o.container_id and sc.service_order_id=?
            where (?='' or position(lower(?) in lower(c.code||' '||cl.name))>0)
              and (?::uuid is null or candidate.previous_client_id=?::uuid)
            """;
        var args=new ArrayList<Object>(Arrays.asList(effectiveDate,clientId,id,id,query,query,sourceClientId,sourceClientId));
        long count=jdbc.queryForObject("select count(*) "+from,Long.class,args.toArray());
        args.add(size);args.add(page*size);
        var rows=jdbc.query("select sc.id as link_id,o.id as owner_id,o.container_id,c.code as container_name,c.container_type,candidate.previous_client_id as client_id,cl.name as client_name,o.status,candidate.container_visit_id,null::uuid as expected_client_id,null::text as result_status,null::text as result_reason "+from+" order by (sc.id is not null) desc,c.code limit ? offset ?",(rs,n)->link(rs),args.toArray());
        return PagedResponse.of(rows,page,size,count);
    }
    record Candidate(UUID visit,UUID previousClient,java.time.OffsetDateTime instant) {}
    /** The caller holds the order and all selected container locks. */
    private Map<UUID,Candidate> validateCandidates(Header h, Map<UUID, UUID> ownersByContainer, boolean accepting) {
        if (ownersByContainer.isEmpty()) {
            if (h.sourceClientId() == null) throw error(HttpStatus.BAD_REQUEST, "SOURCE_CLIENT_REQUIRED", "Укажите прежнего собственника КТК");
            return Map.of();
        }
        if (ownersByContainer.containsValue(null)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "OWNERSHIP_REGISTRY_ENTRY_MISSING",
                    "У выбранного КТК больше нет записи в регистре собственников",
                    "Selected container no longer has an owner in the registry");
        }
        Set<UUID> containers = ownersByContainer.keySet();
        String marks=String.join(",",Collections.nCopies(containers.size(),"?"));
        var args=new ArrayList<Object>(List.of(date(h.effectiveDate()),h.clientId(),h.id()));
        args.addAll(containers);
        var rows=jdbc.query("select * from ownership_transfer_candidates(?::date,?::uuid,?::uuid) where container_id in ("+marks+")",
                (rs,n)->Map.entry(rs.getObject("container_id",UUID.class),
                        new Candidate(rs.getObject("container_visit_id",UUID.class),rs.getObject("previous_client_id",UUID.class),
                                rs.getObject("transfer_at",java.time.OffsetDateTime.class))),args.toArray());
        Map<UUID,Candidate> eligible=new HashMap<>();
        for (var row : rows) eligible.put(row.getKey(), row.getValue());
        for (var owner : ownersByContainer.entrySet()) {
            if (!eligible.containsKey(owner.getKey())) {
                String sourceMessage = accepting ? "Selected containers are no longer available for ownership transfer"
                        : "Container owner %s is not available for service order %s".formatted(owner.getValue(), h.id());
                throw new ApiException(HttpStatus.BAD_REQUEST, "OWNERSHIP_DATE_UNAVAILABLE",
                        "КТК недоступен для передачи. Проверьте дату и выполнение поставки, резерв вывоза, собственников на дату передачи и другие черновики",
                        sourceMessage);
            }
        }
        UUID source=rows.getFirst().getValue().previousClient();
        if (eligible.values().stream().anyMatch(candidate -> !candidate.previousClient().equals(source)))
            throw error(HttpStatus.CONFLICT, "OWNERSHIP_MIXED_SOURCE", "Выберите КТК одного прежнего собственника на дату передачи");
        if (h.sourceClientId()==null) jdbc.update("update service_order set source_client_id=? where id=?",source,h.id());
        return eligible;
    }
    private Map<UUID,Candidate> validateExisting(Header h, List<Link> links, boolean accepting) {
        Map<UUID, UUID> ownersByContainer = new LinkedHashMap<>();
        for (Link link : links) ownersByContainer.put(link.containerId(), link.containerOwnerId());
        stock.lockContainers(ownersByContainer.keySet());
        var eligible=validateCandidates(h, ownersByContainer, accepting);
        for (var link:links){
            if (link.containerVisitId()!=null && !link.containerVisitId().equals(eligible.get(link.containerId()).visit()))
                throw error(HttpStatus.CONFLICT,"OWNERSHIP_VISIT_CHANGED","КТК поступил повторно; обновите состав заявки");
        }
        return eligible;
    }
    @Transactional public Details select(UUID id,List<Selection> selected){
        Header h=locked(id);draft(h);
        if (selected == null) throw error(HttpStatus.BAD_REQUEST, "INVALID_CONTAINER_SELECTION", "Передайте список выбранных КТК");
        var existing = links(id);
        Map<UUID, Link> byLink = new HashMap<>();
        existing.forEach(link -> byLink.put(link.id(), link));
        Map<UUID, UUID> ownersByContainer = new LinkedHashMap<>();
        for(var value:selected){
            if(value==null||(value.id()==null&&value.containerOwnerId()==null))throw error(HttpStatus.BAD_REQUEST,"INVALID_CONTAINER_SELECTION","Укажите id связи или containerOwnerId");
            if (value.id() != null) {
                Link link = byLink.get(value.id());
                if (link == null) throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND, "SERVICE_ORDER_CONTAINER_NOT_FOUND",
                        "Связь КТК не принадлежит заявке", "NotFound");
                ownersByContainer.put(link.containerId(), link.containerOwnerId());
            } else {
                var found=jdbc.query("select container_id from container_owner where id=?",(rs,n)->rs.getObject(1,UUID.class),value.containerOwnerId());
                if (found.isEmpty()) throw ApiException.fromSourceCode(HttpStatus.NOT_FOUND, "CONTAINER_OWNER_NOT_FOUND",
                        "Запись собственника не найдена", "NotFound");
                ownersByContainer.put(found.getFirst(), value.containerOwnerId());
            }
        }
        Set<UUID> containers = ownersByContainer.keySet();
        Set<UUID> lockedIds=new TreeSet<>(containers);existing.forEach(l->lockedIds.add(l.containerId()));stock.lockContainers(lockedIds);
        var eligible=validateCandidates(h, ownersByContainer, false);
        for(var l:existing)if(!containers.contains(l.containerId()))jdbc.update("delete from service_order_container where id=?",l.id());
        for(UUID container:containers)jdbc.update("insert into service_order_container(id,service_order_id,container_id,container_visit_id) values(?,?,?,?) on conflict(service_order_id,container_id) where result_status<>'WITHDRAWN' do update set container_visit_id=excluded.container_visit_id",UUID.randomUUID(),id,container,eligible.get(container).visit());
        return details(id);
    }
    @Transactional public Details accept(UUID id){
        Header h = locked(id);
        if (!h.status().equals("DRAFT")) throw new ApiException(HttpStatus.CONFLICT, "SERVICE_ORDER_NOT_DRAFT",
                "Подтвердить можно только черновик заявки", "Service order can be accepted only from DRAFT status");
        var links = links(id);
        if (links.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "SERVICE_ORDER_CONTAINERS_REQUIRED",
                "Для подтверждения выберите хотя бы один КТК", "Service order must contain equipment");
        LocalDate effective=date(h.effectiveDate());
        var eligible=validateExisting(h,links,true);
        var confirmedAt=jdbc.queryForObject("select billing_now()",java.time.OffsetDateTime.class);
        boolean immediate = !effective.isAfter(confirmedAt.atZoneSameInstant(ScheduledOwnershipTransfers.MOSCOW).toLocalDate());
        if (immediate) stock.requireNoDueOwnershipTransfers(eligible.keySet());
        for (var link : links) {
            var candidate=eligible.get(link.containerId());
            jdbc.update("""
                update service_order_container set container_visit_id=?,expected_client_id=?,expected_status='ON_TERMINAL',
                    plan_client_id=?,plan_at=?,result_status='PLANNED',result_reason=null
                where id=?
                """,candidate.visit(),candidate.previousClient(),h.clientId(),candidate.instant(),link.id());
        }
        jdbc.update("update service_order set status='SCHEDULED',execution_error=null,effective_date=?,completion_at=?::timestamptz at time zone 'UTC',updated_at=?::timestamptz at time zone 'UTC',updated_by='local' where id=?",effective,confirmedAt,confirmedAt,id);
        if (immediate) {
            String reason = jdbc.queryForObject("select apply_ownership_order(?)", String.class, id);
            if (reason != null) throw error(HttpStatus.CONFLICT, "OWNERSHIP_DATE_UNAVAILABLE", reason);
        }
        return details(id);
    }
    @Transactional public Details withdraw(UUID id) {
        Header h=locked(id);
        if(!h.status().equals("SCHEDULED")) throw error(HttpStatus.CONFLICT,"SERVICE_ORDER_NOT_SCHEDULED","Вернуть в черновик можно только ожидающую заявку");
        stock.lockContainers(links(id).stream().map(Link::containerId).toList());
        jdbc.queryForObject("select withdraw_ownership_order(?)",Object.class,id);
        jdbc.update("update service_order set status='DRAFT',execution_error=null,completion_at=null,updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",id);
        return details(id);
    }
    private ApiException error(HttpStatus status,String code,String message){return new ApiException(status,code,message);}
}
