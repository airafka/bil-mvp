package ru.billing.app.waybill;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.error.ApiException;
import ru.billing.app.order.PagedResponse;
import ru.billing.app.comprehensiveserviceorder.ServiceOrderLock;
import tools.jackson.databind.json.JsonMapper;

@Service
public class WaybillPlacementService {
    private final JdbcTemplate jdbc;
    private static final JsonMapper JSON=JsonMapper.builder().build();
    public WaybillPlacementService(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public record Selection(@NotEmpty @Size(max=200) List<@NotNull UUID> waybillIds,
        @Size(max=200) List<@NotNull UUID> wagonIds,String expectedVersion,UUID addWagonId) {}
    public record Assignment(@NotNull UUID rowId,@NotNull UUID wagonId,UUID waybillId) {}
    public record Save(@NotEmpty @Size(max=200) List<@NotNull UUID> waybillIds,
        @NotEmpty @Size(max=200) List<@NotNull UUID> wagonIds,@NotBlank String version,
        @NotEmpty @Size(max=2000) List<@NotNull @Valid Assignment> assignments) {}
    public record Bill(UUID id,String number,UUID receivingId,Integer receivingNumber,String status,
        UUID parent,UUID route,String departure,String destination,String payer) {}
    public record Candidate(UUID id,String number,Integer receivingNumber,int wagonCount,int containerCount,String departure,String destination) {}
    public record Wagon(UUID id,String number,Integer feet,BigDecimal capacity) {}
    public record Container(UUID rowId,UUID containerId,String number,String type,BigDecimal grossWeight,
        UUID waybillId,String waybillNumber,UUID wagonId,boolean selected) {}
    public record Layout(List<Bill> waybills,List<Wagon> wagons,List<Container> containers,String version) {}
    private static String marks(Collection<?> ids){return String.join(",",Collections.nCopies(ids.size(),"?"));}
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
    private static final String BILL_SQL="""
        select w.id,w.number,w.receiving_order_id,r.number as receiving_number,r.order_status,
          r.comprehensive_service_order_id,r.route_id,ds.esr_code as departure,ts.esr_code as destination,p.name as payer
        from waybill w left join receiving_order r on r.id=w.receiving_order_id
        join railway_station ds on ds.id=w.departure_station_id join railway_station ts on ts.id=w.destination_station_id
        join payer p on p.id=w.payer_id
        """;
    private List<Bill> bills(List<UUID> ids){return jdbc.query(BILL_SQL+" where w.id in ("+marks(ids)+") order by w.id",
        (rs,n)->new Bill(rs.getObject(1,UUID.class),rs.getString(2),rs.getObject(3,UUID.class),rs.getObject(4,Integer.class),rs.getString(5),
          rs.getObject(6,UUID.class),rs.getObject(7,UUID.class),rs.getString(8),rs.getString(9),rs.getString(10)),ids.toArray());}
    @Transactional(readOnly=true)
    public PagedResponse<Candidate> candidates(String query,int page,int size) {
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        String from="""
          from waybill w left join receiving_order r on r.id=w.receiving_order_id
          join railway_station ds on ds.id=w.departure_station_id join railway_station ts on ts.id=w.destination_station_id
          where (w.receiving_order_id is null or r.order_status='DRAFT')
          and exists(select 1 from waybill_railway_carriage rc join waybill_container wc on wc.waybill_railway_carriage_id=rc.id where rc.waybill_id=w.id)
          and (?='' or w.number ilike '%'||?||'%' or exists(select 1 from waybill_railway_carriage rc
            join railway_carriage c on c.id=rc.railway_carriage_id left join waybill_container wc on wc.waybill_railway_carriage_id=rc.id
            left join container k on k.id=wc.container_id where rc.waybill_id=w.id and (c.code ilike '%'||?||'%' or k.code ilike '%'||?||'%')))
          """;
        long total=jdbc.queryForObject("select count(*) "+from,Long.class,query,query,query,query);
        var items=jdbc.query("""
          select w.id,w.number,r.number, (select count(distinct rc.railway_carriage_id) from waybill_railway_carriage rc where rc.waybill_id=w.id),
          (select count(*) from waybill_railway_carriage rc join waybill_container wc on wc.waybill_railway_carriage_id=rc.id where rc.waybill_id=w.id),ds.esr_code,ts.esr_code
          """+from+" order by w.number desc,w.id limit ? offset ?",(rs,n)->new Candidate(rs.getObject(1,UUID.class),rs.getString(2),rs.getObject(3,Integer.class),rs.getInt(4),rs.getInt(5),rs.getString(6),rs.getString(7)),query,query,query,query,size,page*size);
        return PagedResponse.of(items,page,size,total);
    }
    private static final String WAGON_SQL="""
        select c.id,c.code,case when t.code in ('PLATFORM_40','PLATFORM_60','PLATFORM_80') then right(t.code,2)::integer end as feet,c.lifting_capacity
        from railway_carriage c left join railway_carriage_type t on t.id=c.type_id
        """;
    private static Wagon wagon(java.sql.ResultSet rs,int n)throws java.sql.SQLException{return new Wagon(rs.getObject(1,UUID.class),rs.getString(2),rs.getObject(3,Integer.class),rs.getBigDecimal(4));}
    @Transactional(readOnly=true)
    public List<Wagon> wagons(String query){return jdbc.query(WAGON_SQL+" where c.code ilike '%'||?||'%' order by c.code limit 30",WaybillPlacementService::wagon,query);}

    @Transactional
    public Layout preview(Selection request) {
        Layout current=load(request.waybillIds(),request.wagonIds());
        if(request.expectedVersion()!=null && !request.expectedVersion().equals(current.version()))throw stale();
        if(request.addWagonId()==null)return current;
        var ids=new ArrayList<>(current.wagons().stream().map(Wagon::id).toList());ids.add(request.addWagonId());
        return load(request.waybillIds(),ids);
    }
    private Layout load(List<UUID> ids,List<UUID> extra) {
        if(new HashSet<>(ids).size()!=ids.size())throw conflict("DUPLICATE_WAYBILL","Накладная выбрана повторно");
        // Same lock as generation and WaybillStore.create: no unseen new loads can appear during save.
        jdbc.execute("select pg_advisory_xact_lock(1743125938)");
        var initial=bills(ids);
        if(initial.size()!=ids.size())throw conflict("WAYBILL_NOT_FOUND","Одна из накладных не найдена");
        initial.stream().map(Bill::parent).filter(Objects::nonNull).distinct().sorted().forEach(id->ServiceOrderLock.lock(jdbc,id));
        initial.stream().map(Bill::route).filter(Objects::nonNull).distinct().sorted().forEach(id->jdbc.queryForList("select id from route where id=? for update",id));
        initial.stream().map(Bill::receivingId).filter(Objects::nonNull).distinct().sorted().forEach(id->jdbc.queryForList("select id from receiving_order where id=? for update",id));
        jdbc.queryForList("select id from waybill where id in ("+marks(ids)+") order by id for update",ids.toArray());
        var selected=bills(ids);
        if(!initial.equals(selected))throw stale();
        for(var bill:selected)if(bill.receivingId()!=null&&!"DRAFT".equals(bill.status()))
            throw conflict("WAYBILL_PLACEMENT_LOCKED","Накладная №"+bill.number()+": редактирование возможно только до подтверждения поставки");
        var wagonIds=new TreeSet<UUID>();
        wagonIds.addAll(jdbc.query("select distinct railway_carriage_id from waybill_railway_carriage where waybill_id in ("+marks(ids)+")",(rs,n)->rs.getObject(1,UUID.class),ids.toArray()));
        if(extra!=null)wagonIds.addAll(extra);
        if(wagonIds.isEmpty()||wagonIds.size()>200)throw conflict("WAGON_SELECTION_LIMIT","Выберите от 1 до 200 вагонов");
        var wagons=jdbc.query(WAGON_SQL+" where c.id in ("+marks(wagonIds)+") order by c.id for share of c",WaybillPlacementService::wagon,wagonIds.toArray());
        if(wagons.size()!=wagonIds.size())throw conflict("WAGON_NOT_FOUND","Один из вагонов не найден");
        var containers=jdbc.query("""
          select wc.id,wc.container_id,c.code,c.container_type,wc.weight,w.id,w.number,rc.railway_carriage_id
          from waybill_container wc join waybill_railway_carriage rc on rc.id=wc.waybill_railway_carriage_id
          join waybill w on w.id=rc.waybill_id join container c on c.id=wc.container_id
          where w.id in (%s)
          order by wc.id
          """.formatted(marks(ids)),(rs,n)->new Container(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),rs.getString(4),rs.getBigDecimal(5),rs.getObject(6,UUID.class),rs.getString(7),rs.getObject(8,UUID.class),true),ids.toArray());
        if(containers.stream().noneMatch(Container::selected))throw conflict("WAYBILL_EMPTY","В выбранных накладных нет КТК");
        return new Layout(selected,wagons,containers,version(selected,wagons,containers));
    }
    private String version(Object... values) {
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsString(values).getBytes(StandardCharsets.UTF_8)));}
        catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException(e);}
    }
    private ApiException stale(){return conflict("WAYBILL_PLACEMENT_CHANGED","Состав накладных или состояние поставки изменились. Загрузите схему заново перед сохранением");}

    @Transactional
    public Layout save(Save request) {
        Layout current=load(request.waybillIds(),request.wagonIds());
        if(!current.version().equals(request.version()))throw stale();
        var selected=current.containers().stream().filter(Container::selected).toList();
        Map<UUID,Assignment> targets=new HashMap<>();
        Map<UUID,Bill> billsById=new HashMap<>();
        current.waybills().forEach(b->billsById.put(b.id(),b));
        Set<UUID> allowed=new HashSet<>(current.wagons().stream().map(Wagon::id).toList());
        for(var item:request.assignments())if(targets.put(item.rowId(),item)!=null||!allowed.contains(item.wagonId())
            ||(item.waybillId()!=null&&!billsById.containsKey(item.waybillId())))
            throw conflict("INVALID_PLACEMENT","Повтор КТК, неизвестный вагон или невыбранная накладная в схеме");
        if(!targets.keySet().equals(new HashSet<>(selected.stream().map(Container::rowId).toList())))
            throw conflict("INVALID_PLACEMENT","Состав КТК должен совпадать с выбранными накладными");
        for(var c:selected) {
            var target=targets.get(c.rowId());
            if(target.waybillId()!=null&&!target.waybillId().equals(c.waybillId()))
                throw conflict("WAYBILL_IDENTITY_CHANGED","При перемещении КТК должен сохранять свою накладную. Загрузите схему заново");
            targets.put(c.rowId(),new Assignment(c.rowId(),target.wagonId(),c.waybillId()));
        }
        var physical=new HashSet<UUID>();
        for(var c:current.containers())if(!physical.add(c.containerId()))throw conflict("DUPLICATE_CONTAINER","КТК "+c.number()+" встречается в нескольких накладных схемы. Сначала устраните дублирование");
        var errors=new ArrayList<String>();
        for(var w:current.wagons()) {
            var rows=current.containers().stream().filter(c->w.id().equals((targets.containsKey(c.rowId())?targets.get(c.rowId()).wagonId():c.wagonId()))).toList();
            if(rows.isEmpty())continue;
            var lengths=rows.stream().mapToInt(c->WaybillPlacementPolicy.containerFeet(c.type())).toArray();
            int feet=Arrays.stream(lengths).anyMatch(n->n<0)?-1:Arrays.stream(lengths).sum();
            String issue=WaybillPlacementPolicy.violation(feet,w.feet());
            if(issue!=null)errors.add("Вагон "+w.number()+": "+issue);
        }
        if(!errors.isEmpty())throw conflict("WAGON_CAPACITY_EXCEEDED",String.join("; ",errors));
        var links=assignCarriageLinks(request.waybillIds(),targets.values());
        UUID batch=UUID.randomUUID();
        for(var c:selected) {
            var target=targets.get(c.rowId());
            UUID link=links.get(new Position(c.waybillId(),target.wagonId()));
            jdbc.update("update waybill_container set waybill_railway_carriage_id=? where id=? and waybill_railway_carriage_id<>?",link,c.rowId(),link);
            if(target.wagonId().equals(c.wagonId()))continue;
            jdbc.update("insert into waybill_container_relocation(id,batch_id,waybill_id,waybill_container_id,container_id,from_railway_carriage_id,to_railway_carriage_id,to_waybill_id) values(?,?,?,?,?,?,?,?)",
                UUID.randomUUID(),batch,c.waybillId(),c.rowId(),c.containerId(),c.wagonId(),target.wagonId(),c.waybillId());
        }
        jdbc.update("delete from waybill_railway_carriage rc where rc.waybill_id in ("+marks(request.waybillIds())+") and not exists(select 1 from waybill_container where waybill_railway_carriage_id=rc.id)",request.waybillIds().toArray());
        return load(request.waybillIds(),request.wagonIds());
    }
    private record Position(UUID waybillId,UUID wagonId) {}
    private record CarriageLink(UUID id,UUID waybillId,UUID wagonId) {}

    private Map<Position,UUID> assignCarriageLinks(List<UUID> waybillIds,Collection<Assignment> targets) {
        var existing=jdbc.query("select id,waybill_id,railway_carriage_id from waybill_railway_carriage where waybill_id in ("+marks(waybillIds)+") order by id for update",
            (rs,n)->new CarriageLink(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getObject(3,UUID.class)),waybillIds.toArray());
        var needed=new LinkedHashSet<Position>();
        targets.stream().sorted(Comparator.comparing(Assignment::rowId)).forEach(t->needed.add(new Position(t.waybillId(),t.wagonId())));
        Map<Position,UUID> result=new HashMap<>();
        Set<UUID> used=new HashSet<>();
        // Reserve pairs used by stationary KTK before moving a whole link of the same waybill.
        for(var link:existing) {
            var position=new Position(link.waybillId(),link.wagonId());
            if(needed.contains(position)&&!result.containsKey(position)) {
                result.put(position,link.id());used.add(link.id());
            }
        }
        for(var position:needed) {
            if(result.containsKey(position))continue;
            var reusable=existing.stream().filter(l->l.waybillId().equals(position.waybillId())&&!used.contains(l.id())).findFirst();
            UUID id;
            if(reusable.isPresent()) {
                id=reusable.get().id();
                jdbc.update("update waybill_railway_carriage set railway_carriage_id=? where id=?",position.wagonId(),id);
            } else {
                id=UUID.randomUUID();
                jdbc.update("insert into waybill_railway_carriage(id,waybill_id,railway_carriage_id) values(?,?,?)",id,position.waybillId(),position.wagonId());
            }
            result.put(position,id);used.add(id);
        }
        return result;
    }
}
