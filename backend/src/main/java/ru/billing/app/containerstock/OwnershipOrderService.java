package ru.billing.app.containerstock;

import java.util.*;
import java.time.LocalDateTime;
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
    public record Create(@NotNull UUID clientId,@NotNull ServiceType service,@Size(max=1000)String comment,@NotEmpty(message="Выберите хотя бы один КТК") List<@NotNull UUID> containerOwnerIds,LocalDate effectiveDate) {}
    public record Update(@NotNull UUID id,@NotNull ServiceType service,@Size(max=1000)String comment,LocalDate effectiveDate) {}
    public record Selection(UUID id,UUID containerOwnerId) {}
    public record Link(UUID id,UUID containerOwnerId,UUID containerId,String containerName,String containerType,
            UUID clientId,String clientName,String status,UUID containerVisitId,UUID expectedClientId,String resultStatus,String resultReason) {}
    public record Header(UUID id,long number,UUID clientId,String clientName,String service,String comment,
            String status,LocalDateTime completionAt,long containerQuantity,LocalDate effectiveDate) {}
    public record Details(Header order,List<Link> containers) {}
    private static final String HEADER="""
        select s.*,c.name as client_name,(select count(*) from service_order_container sc where sc.service_order_id=s.id) as quantity
        from service_order_current s join client c on c.id=s.client_id
        """;
    private Header header(java.sql.ResultSet rs)throws java.sql.SQLException {
        return new Header(rs.getObject("id",UUID.class),rs.getLong("number"),rs.getObject("client_id",UUID.class),rs.getString("client_name"),
            rs.getString("service"),rs.getString("comment"),rs.getString("status"),rs.getObject("completion_at",LocalDateTime.class),rs.getLong("quantity"),rs.getObject("effective_date",LocalDate.class));
    }
    private Header locked(UUID id){
        var ids=jdbc.query("select id from service_order where id=? for update",(rs,n)->rs.getObject(1,UUID.class),id);
        if(ids.isEmpty())throw error(HttpStatus.NOT_FOUND,"SERVICE_ORDER_NOT_FOUND","Заявка на смену собственника не найдена");
        return jdbc.queryForObject(HEADER+" where s.id=?",(rs,n)->header(rs),id);
    }
    private void draft(Header h){if(!h.status().equals("DRAFT"))throw error(HttpStatus.CONFLICT,"SERVICE_ORDER_NOT_DRAFT","Изменение доступно только для черновика заявки");}
    private LocalDate date(LocalDate value) {
        if(value==null) return jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(value.getYear()<1 || value.getYear()>9999) throw error(HttpStatus.BAD_REQUEST,"INVALID_EFFECTIVE_DATE","Укажите дату передачи с годом от 1 до 9999");
        return value;
    }
    @Transactional(readOnly=true)
    public PagedResponse<Header> page(String query,String status,int page,int size){
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        String filter=" where (?='' or position(lower(?) in lower(concat_ws(' ',s.number::text,c.name,s.comment)))>0) and (?='' or s.status=?)";
        long count=jdbc.queryForObject("select count(*) from ("+HEADER+filter+") q",Long.class,query,query,status,status);
        return PagedResponse.of(jdbc.query(HEADER+filter+" order by s.number desc limit ? offset ?",(rs,n)->header(rs),query,query,status,status,size,page*size),page,size,count);
    }
    @Transactional public Details create(Create request){
        if(request.containerOwnerIds()==null || request.containerOwnerIds().isEmpty())throw error(HttpStatus.BAD_REQUEST,"SERVICE_ORDER_CONTAINERS_REQUIRED","Выберите хотя бы один КТК");
        if(jdbc.queryForObject("select count(*) from client where id=?",Integer.class,request.clientId())==0)throw error(HttpStatus.NOT_FOUND,"CLIENT_NOT_FOUND","Клиент не найден");
        UUID id=UUID.randomUUID();
        jdbc.update("insert into service_order(id,client_id,service,comment,effective_date) values(?,?,?,?,?)",id,request.clientId(),request.service().name(),request.comment(),date(request.effectiveDate()));
        return select(id,request.containerOwnerIds().stream().map(ownerId -> new Selection(null,ownerId)).toList());
    }
    @Transactional(readOnly=true)public Details details(UUID id){
        var rows=jdbc.query(HEADER+" where s.id=?",(rs,n)->header(rs),id);
        if(rows.isEmpty())throw error(HttpStatus.NOT_FOUND,"SERVICE_ORDER_NOT_FOUND","Заявка не найдена");
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
        jdbc.update("update service_order set service=?,comment=?,effective_date=?,updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",request.service().name(),request.comment(),date(request.effectiveDate()==null?h.effectiveDate():request.effectiveDate()),id);
        return details(id);
    }
    @Transactional public void delete(UUID id){
        draft(locked(id));
        if(Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from container_ownership_period where service_order_id=?)",Boolean.class,id)))
            throw error(HttpStatus.CONFLICT,"SERVICE_ORDER_HAS_HISTORY","Ранее подтверждённая заявка сохраняется для истории; её можно изменить и подтвердить повторно");
        jdbc.update("delete from service_order_container where service_order_id=?",id);jdbc.update("delete from service_order where id=?",id);
    }
    @Transactional(readOnly=true)public PagedResponse<Link> available(UUID id,LocalDate effectiveDate,String query,int page,int size){
        var h=details(id).order();draft(h);
        return candidates(id,h.clientId(),date(effectiveDate==null?h.effectiveDate():effectiveDate),query,page,size);
    }
    @Transactional(readOnly=true)public PagedResponse<Link> availableForCreate(UUID clientId,LocalDate effectiveDate,String query,int page,int size){
        return candidates(null,clientId,date(effectiveDate),query,page,size);
    }
    private PagedResponse<Link> candidates(UUID id,UUID clientId,LocalDate effectiveDate,String query,int page,int size){
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        String from="""
            from ownership_transfer_candidates(?::date,?::uuid,?::uuid) candidate
            join container_owner o on o.id=candidate.owner_id join container c on c.id=o.container_id
            join client cl on cl.id=candidate.previous_client_id
            left join service_order_container sc on sc.container_id=o.container_id and sc.service_order_id=?
            where (?='' or position(lower(?) in lower(c.code||' '||cl.name))>0)
            """;
        var args=new ArrayList<Object>(Arrays.asList(effectiveDate,clientId,id,id,query,query));
        long count=jdbc.queryForObject("select count(*) "+from,Long.class,args.toArray());
        args.add(size);args.add(page*size);
        var rows=jdbc.query("select sc.id as link_id,o.id as owner_id,o.container_id,c.code as container_name,c.container_type,candidate.previous_client_id as client_id,cl.name as client_name,o.status,candidate.container_visit_id,null::uuid as expected_client_id,null::text as result_status,null::text as result_reason "+from+" order by (sc.id is not null) desc,c.code limit ? offset ?",(rs,n)->link(rs),args.toArray());
        return PagedResponse.of(rows,page,size,count);
    }
    record Candidate(UUID visit,UUID previousClient,java.time.OffsetDateTime instant) {}
    private Candidate candidate(UUID container,Header h){
        var rows=jdbc.query("select * from ownership_transfer_candidates(?::date,?::uuid,?::uuid) where container_id=?",(rs,n)->new Candidate(rs.getObject("container_visit_id",UUID.class),rs.getObject("previous_client_id",UUID.class),rs.getObject("transfer_at",java.time.OffsetDateTime.class)),date(h.effectiveDate()),h.clientId(),h.id(),container);
        if(rows.isEmpty())throw error(HttpStatus.CONFLICT,"OWNERSHIP_DATE_UNAVAILABLE","КТК недоступен на выбранную дату: проверьте фактический receiving, остатки, собственника на дату передачи и другие черновики");
        return rows.getFirst();
    }
    @Transactional public Details select(UUID id,List<Selection> selected){
        Header h=locked(id);draft(h);
        if(selected==null || selected.isEmpty())throw error(HttpStatus.BAD_REQUEST,"SERVICE_ORDER_CONTAINERS_REQUIRED","Выберите хотя бы один КТК");
        var existing=links(id);Map<UUID,Link> byLink=new HashMap<>();existing.forEach(l->byLink.put(l.id(),l));
        Set<UUID> containers=new TreeSet<>();
        for(var value:selected){
            if(value==null||(value.id()==null&&value.containerOwnerId()==null))throw error(HttpStatus.BAD_REQUEST,"INVALID_CONTAINER_SELECTION","Укажите id связи или containerOwnerId");
            if(value.id()!=null){var l=byLink.get(value.id());if(l==null)throw error(HttpStatus.NOT_FOUND,"SERVICE_ORDER_CONTAINER_NOT_FOUND","Связь КТК не принадлежит заявке");containers.add(l.containerId());}
            else {
                var found=jdbc.query("select container_id from container_owner where id=?",(rs,n)->rs.getObject(1,UUID.class),value.containerOwnerId());
                if(found.isEmpty())throw error(HttpStatus.NOT_FOUND,"CONTAINER_OWNER_NOT_FOUND","Запись собственника не найдена");containers.add(found.getFirst());
            }
        }
        Set<UUID> lockedIds=new TreeSet<>(containers);existing.forEach(l->lockedIds.add(l.containerId()));stock.lockContainers(lockedIds);
        Map<UUID,Candidate> eligible=new HashMap<>();
        for(UUID container:containers)eligible.put(container,candidate(container,h));
        for(var l:existing)if(!containers.contains(l.containerId()))jdbc.update("delete from service_order_container where id=?",l.id());
        for(UUID container:containers)jdbc.update("insert into service_order_container(id,service_order_id,container_id,container_visit_id) values(?,?,?,?) on conflict(service_order_id,container_id) do update set container_visit_id=excluded.container_visit_id",UUID.randomUUID(),id,container,eligible.get(container).visit());
        return details(id);
    }
    @Transactional public Details accept(UUID id){
        Header h=locked(id);draft(h);var links=links(id);
        if(links.isEmpty())throw error(HttpStatus.BAD_REQUEST,"SERVICE_ORDER_CONTAINERS_REQUIRED","Выберите хотя бы один КТК");
        LocalDate effective=date(h.effectiveDate());
        stock.lockContainers(links.stream().map(Link::containerId).toList());
        var confirmedAt=jdbc.queryForObject("select billing_now()",java.time.OffsetDateTime.class);
        for(var l:links){var state=stock.state(l.containerId());
            var candidate=candidate(l.containerId(),h);
            if(l.containerVisitId()!=null && !l.containerVisitId().equals(candidate.visit()))throw error(HttpStatus.CONFLICT,"OWNERSHIP_VISIT_CHANGED","КТК поступил повторно; обновите состав заявки");
            var effectiveAt=candidate.instant();
            UUID period=stock.assignOwner(l.containerId(),candidate.previousClient(),h.clientId(),state.status(),id,effectiveAt);
            jdbc.update("update service_order_container sc set container_visit_id=o.container_visit_id,expected_client_id=?,expected_status=o.status,result_status='CONFIRMED',result_reason=null,container_ownership_period_id=? from container_owner o where sc.service_order_id=? and sc.container_id=? and o.container_id=sc.container_id",candidate.previousClient(),period,id,l.containerId());
        }
        jdbc.update("update service_order set status='CONFIRMED',effective_date=?,completion_at=?::timestamptz at time zone 'UTC',updated_at=?::timestamptz at time zone 'UTC',updated_by='local' where id=?",effective,confirmedAt,confirmedAt,id);
        return details(id);
    }
    @Transactional public Details withdraw(UUID id) {
        Header h=locked(id);
        if(!h.status().equals("SCHEDULED")) throw error(HttpStatus.CONFLICT,"SERVICE_ORDER_NOT_SCHEDULED","Вернуть в черновик можно только ожидающую заявку");
        stock.lockContainers(links(id).stream().map(Link::containerId).toList());
        var periods=jdbc.query("select container_ownership_period_id from service_order_container where service_order_id=? and container_ownership_period_id is not null",(rs,n)->rs.getObject(1,UUID.class),id);
        for(UUID period:periods) jdbc.queryForObject("select withdraw_ownership_period(?,?)",Object.class,period,"Заявка возвращена в черновик");
        jdbc.update("update service_order_container set container_ownership_period_id=null,container_visit_id=null,expected_client_id=null,expected_status=null,result_status='DRAFT',result_reason=null where service_order_id=?",id);
        jdbc.update("update service_order set status='DRAFT',completion_at=null,updated_at=billing_now() at time zone 'UTC',updated_by='local' where id=?",id);
        return details(id);
    }
    private ApiException error(HttpStatus status,String code,String message){return new ApiException(status,code,message);}
}
