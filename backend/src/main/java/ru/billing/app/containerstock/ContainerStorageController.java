package ru.billing.app.containerstock;

import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.nio.charset.StandardCharsets;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.error.ApiException;
import ru.billing.app.order.PagedResponse;

@RestController
@RequestMapping({"/api/container-periods", "/api/container-storage-periods"})
@Transactional(readOnly=true)
public class ContainerStorageController {
    private final JdbcTemplate jdbc;
    public ContainerStorageController(JdbcTemplate jdbc) {this.jdbc=jdbc;}
    public record Row(UUID id,UUID containerId,String containerName,
        String ownerName,OffsetDateTime arrivalAt,OffsetDateTime departureAt,String status,long storageDays,
        UUID startOrderId,String startOrderType,Long startOrderNumber,UUID endOrderId,String endOrderType,Long endOrderNumber,
        String receivingClientName,String receivingOwnerName,String arrivalTransport,String arrivalParty,String arrivalCargo,
        String shippingClientName,String shippingOwnerName,String departureTransport,String departureParty,String departureCargo) {}
    private static final String FROM="""
        from container_storage_period_at(?::date) p
        join container_owner_history h on h.id=p.start_history_id
        join container c on c.id=p.container_id
        """;
    private static final String SELECT="""
        select p.id,p.container_id,c.code container_name,ow.name owner_name,
          h.occurred_at receiving_at,e.occurred_at shipping_at,p.status,
          h.order_id start_order_id,h.order_type start_order_type,
          case h.order_type when 'RECEIVING_ORDER' then r.number when 'SERVICE_ORDER' then so.number end::bigint start_order_number,
          e.order_id end_order_id,e.order_type end_order_type,
          case e.order_type when 'SHIPPING_ORDER' then s.number when 'SERVICE_ORDER' then eo.number end::bigint end_order_number,
          rc.name receiving_client_name,ro.name receiving_owner_name,r.transport_type arrival_transport,
          case r.transport_type when 'VEHICLE' then ic.name when 'RAILWAY' then r.consignor end arrival_party,
          incoming.cargo_name arrival_cargo,
          sc.name shipping_client_name,sw.name shipping_owner_name,s.transport_type departure_transport,
          case s.transport_type when 'VEHICLE' then oc.name when 'RAILWAY' then cons.name end departure_party,
          outgoing.cargo_name departure_cargo
        from report_periods p
        join container_owner_history h on h.id=p.start_history_id
        join container c on c.id=p.container_id
        left join container_owner_history e on e.id=p.end_history_id
        join client ow on ow.id=h.new_client_id
        join container_owner_history origin on origin.id=storage_arrival_history(p.id)
        join receiving_order r on r.id=origin.order_id
        left join service_order so on so.id=h.order_id and h.order_type='SERVICE_ORDER'
        left join shipping_order s on s.id=e.order_id and e.order_type='SHIPPING_ORDER'
        left join service_order eo on eo.id=e.order_id and e.order_type='SERVICE_ORDER'
        left join receiving_order_container rr on rr.receiving_order_id=r.id and rr.container_id=p.container_id and r.transport_type='VEHICLE'
        left join lateral (
          select wc.owner_container_id,wr.waybill_id
          from waybill w join waybill_railway_carriage wr on wr.waybill_id=w.id
          join waybill_container wc on wc.waybill_railway_carriage_id=wr.id
          where w.receiving_order_id=r.id and wc.container_id=p.container_id and r.transport_type='RAILWAY'
        ) rail on true
        left join shipping_order_container sr on sr.shipping_order_id=s.id and sr.container_id=p.container_id
        left join client rc on rc.id=r.client_id
        left join client ro on ro.id=coalesce(rr.owner_container_id,rail.owner_container_id,r.default_container_owner_id)
        left join client sc on sc.id=s.client_id
        left join client sw on sw.id=sr.owner_container_id
        left join route ir on ir.id=r.route_id
        left join client_related_entity ic on ic.id=ir.client_related_entity_id
        left join route outr on outr.id=s.route_id
        left join client_related_entity oc on oc.id=outr.client_related_entity_id
        left join client_related_entity cons on cons.id=s.consignee_id
        left join lateral (
          select string_agg(distinct ec.code,'; ' order by ec.code) cargo_name
          from (
            select i.etsng_code_id from receiving_order_container_item i where i.receiving_order_container_id=rr.id
            union select wp.etsng_code_id from waybill_product wp where wp.waybill_id=rail.waybill_id
          ) products join etsng_code ec on ec.id=products.etsng_code_id
        ) incoming on true
        left join lateral (
          select string_agg(distinct ec.code,'; ' order by ec.code) cargo_name
          from shipping_order_container_item i join etsng_code ec on ec.id=i.etsng_code_id
          where i.shipping_order_container_id=sr.id
        ) outgoing on true
        """;
    private static String reportQuery(Filter filter,boolean paged) {
        // Resolve source documents only for selected rows; keep the count independent of cargo joins.
        return "with report_periods as materialized (select p.* "+FROM+filter.sql()
            +" order by h.occurred_at desc,p.id"+(paged?" limit ? offset ?":"")+") "
            +SELECT+" order by h.occurred_at desc,p.id";
    }
    record Filter(String sql,List<Object> args) {}
    private Filter filter(String query,String status,UUID clientId,UUID periodId,LocalDate from,LocalDate to,LocalDate asOf) {
        if(!Set.of("ACTIVE","OPEN","CLOSED","CANCELLED","ALL").contains(status))
            throw bad("Неизвестное состояние хранения");
        if(from!=null && to!=null && from.isAfter(to)) throw bad("Начало периода фильтра позже окончания");

        var args=new ArrayList<Object>();args.add(asOf);
        String sql=" where p.status in ('OPEN','CLOSED') and (?='' or position(lower(?) in lower(c.code))>0)";
        args.add(query.trim());args.add(query.trim());
        // Retain the legacy client filter; only this optional filter needs the original arrival chain.
        if(clientId!=null){sql+=" and exists(select 1 from container_storage_period_origin o join receiving_order r on r.id=o.receiving_order_id where o.id=p.id and r.client_id=?)";args.add(clientId);}
        if(periodId!=null){sql+=" and p.id=?";args.add(periodId);}
        if(from!=null){sql+=" and (h.occurred_at at time zone 'UTC')::date>=?";args.add(from);}
        if(to!=null){sql+=" and (h.occurred_at at time zone 'UTC')::date<=?";args.add(to);}
        sql+=" and (h.occurred_at at time zone 'Europe/Moscow')::date<=?";args.add(asOf);
        sql+=switch(status){case "ACTIVE"->" and p.status<>'CANCELLED'";
            case "ALL"->"";default->" and p.status=?";};
        if(Set.of("OPEN","CLOSED","CANCELLED").contains(status))args.add(status);
        return new Filter(sql,args);
    }
    @GetMapping
    public PagedResponse<Row> page(@RequestParam(defaultValue="")String query,@RequestParam(defaultValue="ACTIVE")String status,
            @RequestParam(required=false)UUID clientId,@RequestParam(required=false)UUID periodId,@RequestParam(required=false)LocalDate arrivalFrom,
            @RequestParam(required=false)LocalDate arrivalTo,@RequestParam(required=false)LocalDate asOf,
            @RequestParam(defaultValue="0")int page,@RequestParam(defaultValue="20")int size) {
        var reportDate=date(asOf);
        var f=filter(query,status,clientId,periodId,arrivalFrom,arrivalTo,reportDate);
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        long count=jdbc.queryForObject("select count(*) "+FROM+f.sql(),Long.class,f.args().toArray());
        var args=new ArrayList<>(f.args());args.add(size);args.add((long)page*size);
        return PagedResponse.of(jdbc.query(reportQuery(f,true),
            (rs,n)->row(rs,reportDate),args.toArray()),page,size,count);
    }
    public record ContainerOption(UUID id, String name) {}
    public record Visit(UUID id,UUID containerId,String containerName,OffsetDateTime receivingAt,OffsetDateTime shippingAt,
        UUID receivingOrderId,Long receivingOrderNumber,UUID shippingOrderId,Long shippingOrderNumber,
        long storageDays,List<Row> periods) {}
    public record StayPeriod(YearMonth month, LocalDate storedFrom, LocalDate storedTo) {
        boolean specified() { return month!=null || storedFrom!=null || storedTo!=null; }

        Filter visits(String query, UUID periodId, LocalDate asOf) {
            if (month!=null && (storedFrom!=null || storedTo!=null))
                throw bad("Выберите месяц или диапазон дат");
            LocalDate from=month==null ? storedFrom : month.atDay(1);
            LocalDate to=month==null ? storedTo : month.atEndOfMonth();
            if (from!=null && to!=null && from.isAfter(to))
                throw bad("Дата начала позже даты окончания");

            var args=new ArrayList<Object>();
            String sql=" from container_visit_facts v join container c on c.id=v.container_id"
                +" where not v.is_cancelled and v.receiving_date<=?";
            args.add(to==null || to.isAfter(asOf) ? asOf : to);
            if (from!=null) {
                // PostgreSQL LEAST uses asOf for an open visit and caps a later departure at asOf.
                sql+=" and least(v.shipping_date,?::date)>=?";
                args.add(asOf);
                args.add(from);
            }
            if (!query.isBlank()) {
                sql+=" and position(lower(?) in lower(c.code))>0";
                args.add(query.trim());
            }
            if (periodId!=null) {
                sql+=" and exists(select 1 from active_container_period ap"
                    +" join container_owner_history h on h.id=ap.start_container_owner_history_id"
                    +" where ap.container_visit_id=v.id and ap.id=?"
                    +" and (h.occurred_at at time zone 'Europe/Moscow')::date<=?)";
                args.add(periodId);
                args.add(asOf);
            }
            return new Filter(sql,args);
        }
    }
    @GetMapping("/visits")
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public PagedResponse<Visit> visits(@RequestParam(defaultValue="")String query,@RequestParam(required=false)UUID periodId,
            @ModelAttribute StayPeriod stay,@RequestParam(required=false)LocalDate asOf,@RequestParam(defaultValue="0")int page,@RequestParam(defaultValue="20")int size) {
        var reportDate=date(asOf);
        var f=stay.visits(query,periodId,reportDate);
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        long count=jdbc.queryForObject("select count(*)"+f.sql(),Long.class,f.args().toArray());
        var args=new ArrayList<>(f.args());args.add(size);args.add((long)page*size);
        var ids=jdbc.query("select v.id"+f.sql()+" order by v.receiving_date desc,v.id limit ? offset ?",
            (rs,n)->rs.getObject(1,UUID.class),args.toArray());
        if(ids.isEmpty())return PagedResponse.of(List.of(),page,size,count);
        // Page complete visits first, then load every visible ownership period for those visits.
        // A period deep link selects its visit without truncating that visit's ownership chain.
        var periodsByVisit=new LinkedHashMap<UUID,List<Row>>();ids.forEach(id->periodsByVisit.put(id,new ArrayList<>()));
        var periodsArgs=new ArrayList<Object>();periodsArgs.add(reportDate);periodsArgs.addAll(ids);
        String sql="with report_periods as materialized (select p.*,op.container_visit_id from container_storage_period_at(?::date) p "
            +"join container_period op on op.id=p.id where p.status in ('OPEN','CLOSED') and op.container_visit_id in ("
            +String.join(",",Collections.nCopies(ids.size(),"?"))+")) "
            +SELECT.replace("select p.id,","select p.container_visit_id,p.id,")+" order by h.occurred_at,h.created_at,h.id";
        jdbc.query(sql,(org.springframework.jdbc.core.RowCallbackHandler)rs->periodsByVisit.get(rs.getObject("container_visit_id",UUID.class)).add(row(rs,reportDate)),periodsArgs.toArray());
        var visits=new ArrayList<Visit>();
        periodsByVisit.forEach((id,periods)->{
            Row first=periods.getFirst(),last=periods.getLast();boolean shipped="SHIPPING_ORDER".equals(last.endOrderType());
            visits.add(new Visit(id,first.containerId(),first.containerName(),first.arrivalAt(),shipped?last.departureAt():null,
                first.startOrderId(),first.startOrderNumber(),shipped?last.endOrderId():null,shipped?last.endOrderNumber():null,
                periods.stream().mapToLong(Row::storageDays).sum(),List.copyOf(periods)));
        });
        return PagedResponse.of(visits,page,size,count);
    }
    @GetMapping("/containers")
    public List<ContainerOption> containers() {
        return jdbc.query("""
            select c.id,c.code from container c
            where exists(select 1 from container_visit_facts v where v.container_id=c.id and not v.is_cancelled
                         and v.receiving_date<=billing_today())
            order by c.code,c.id
            """, (rs,n)->new ContainerOption(rs.getObject(1,UUID.class),rs.getString(2)));
    }
    @GetMapping(value="/export",produces="text/csv")
    public ResponseEntity<byte[]> export(@RequestParam(defaultValue="")String query,@RequestParam(defaultValue="ACTIVE")String status,
            @RequestParam(required=false)UUID clientId,@RequestParam(required=false)UUID periodId,@RequestParam(required=false)LocalDate arrivalFrom,
            @RequestParam(required=false)LocalDate arrivalTo,@RequestParam(required=false)LocalDate asOf,
            @ModelAttribute StayPeriod stay,@RequestParam(required=false)UUID visitPeriodId) {
        var reportDate=date(asOf);
        var f=filter(query,status,clientId,periodId,arrivalFrom,arrivalTo,reportDate);
        if (stay.specified() || visitPeriodId!=null) {
            var visits=stay.visits("",visitPeriodId,reportDate);
            var args=new ArrayList<>(f.args());
            args.addAll(visits.args());
            f=new Filter(f.sql()+" and p.id in (select op.id from container_period op"
                +" where op.container_visit_id in (select v.id"+visits.sql()+"))",args);
        }
        var out=new StringBuilder("\uFEFF");
        csv(out,"Номер КТК","Собственник КТК","Дней хранения","Начало периода","Событие","Заявка",
            "Конец периода","Событие","Заявка","Клиент/Собственник поставки","Транспорт поставки",
            "Грузоперевозчик/грузоотправитель поставки","Груз поставки","Клиент/Собственник вывоза","Транспорт вывоза",
            "Грузоперевозчик/грузополучатель вывоза","Груз вывоза");
        jdbc.query(reportQuery(f,false),rs->{
            Row r=row(rs,reportDate);csv(out,r.containerName(),r.ownerName(),r.storageDays(),format(r.arrivalAt()),
                boundary(r.startOrderType()),r.startOrderNumber(),format(r.departureAt()),boundary(r.endOrderType()),r.endOrderNumber(),
                clientOwner(r.receivingClientName(),r.receivingOwnerName()),transport(r.arrivalTransport()),r.arrivalParty(),r.arrivalCargo(),
                clientOwner(r.shippingClientName(),r.shippingOwnerName()),transport(r.departureTransport()),r.departureParty(),r.departureCargo());
        },f.args().toArray());
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION,"attachment; filename=container-storage.csv")
            .contentType(new MediaType("text","csv",StandardCharsets.UTF_8)).body(out.toString().getBytes(StandardCharsets.UTF_8));
    }
    static void csv(StringBuilder out,Object... values) {
        var cells=new ArrayList<String>();for(Object v:values){String s=v==null?"":v.toString();
            String trimmed=s.stripLeading();
            if(!trimmed.isEmpty() && "=+-@".indexOf(trimmed.charAt(0))>=0)s="'"+s;
            cells.add("\""+s.replace("\"","\"\"")+"\"");}out.append(String.join(";",cells)).append("\r\n");
    }
    static String format(OffsetDateTime value){return value==null?"":value.withOffsetSameInstant(ZoneOffset.UTC)
        .format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm 'UTC'"));}
    private static String boundary(String s){return s==null?"":switch(s){case "RECEIVING_ORDER"->"Поставка";case "SHIPPING_ORDER"->"Вывоз";case "SERVICE_ORDER"->"Смена собственника";default->s;};}
    private static String clientOwner(String client,String owner) {
        return client==null && owner==null?"":(client==null?"—":client)+" / "+(owner==null?"—":owner);
    }
    private static String transport(String value) {
        return value==null?"":switch(value){case "VEHICLE"->"Авто";case "RAILWAY"->"ЖД";default->value;};
    }
    private LocalDate date(LocalDate d) {
        LocalDate today=jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(d!=null && d.isAfter(today)) throw bad("Дата расчёта не может быть позже рабочей даты");
        return d==null?today:d;
    }
    private static ApiException bad(String message){return new ApiException(HttpStatus.BAD_REQUEST,"INVALID_STORAGE_FILTER",message);}
    static long storageDays(OffsetDateTime start,OffsetDateTime end,String endOrderType,LocalDate asOf) {
        var zone=ZoneId.of("Europe/Moscow");
        var first=start.atZoneSameInstant(zone).toLocalDate();
        var last=end==null?asOf:end.atZoneSameInstant(zone).toLocalDate();
        if(end!=null && "SERVICE_ORDER".equals(endOrderType))last=last.minusDays(1);
        if(last.isAfter(asOf))last=asOf;
        return Math.max(0,ChronoUnit.DAYS.between(first,last)+1);
    }
    private Row row(ResultSet rs,LocalDate asOf)throws SQLException {
        String status=rs.getString("status");
        var start=rs.getObject("receiving_at",OffsetDateTime.class);
        var end=rs.getObject("shipping_at",OffsetDateTime.class);
        var endType=rs.getString("end_order_type");
        return new Row(rs.getObject("id",UUID.class),rs.getObject("container_id",UUID.class),rs.getString("container_name"),
            rs.getString("owner_name"),start,end,status,storageDays(start,end,endType,asOf),
            rs.getObject("start_order_id",UUID.class),rs.getString("start_order_type"),rs.getObject("start_order_number",Long.class),
            rs.getObject("end_order_id",UUID.class),rs.getString("end_order_type"),rs.getObject("end_order_number",Long.class),
            rs.getString("receiving_client_name"),rs.getString("receiving_owner_name"),rs.getString("arrival_transport"),rs.getString("arrival_party"),rs.getString("arrival_cargo"),
            rs.getString("shipping_client_name"),rs.getString("shipping_owner_name"),rs.getString("departure_transport"),rs.getString("departure_party"),rs.getString("departure_cargo"));
    }
}
