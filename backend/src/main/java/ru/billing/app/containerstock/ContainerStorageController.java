package ru.billing.app.containerstock;

import java.time.*;
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
@RequestMapping("/api/container-storage-periods")
@Transactional(readOnly=true)
public class ContainerStorageController {
    private final JdbcTemplate jdbc;
    public ContainerStorageController(JdbcTemplate jdbc) {this.jdbc=jdbc;}
    public record Row(UUID id,UUID containerId,String containerName,String terminalAreaName,
        UUID receivingOrderId,Long receivingOrderNumber,OffsetDateTime arrivalAt,String clientName,String ownerName,
        String arrivalTransport,String arrivalCarrier,String consignor,String cargoName,Boolean empty,
        UUID shippingOrderId,Long shippingOrderNumber,OffsetDateTime departureAt,String departureTransport,
        String departureCarrier,String consignee,String shippingClientName,String shippingOwnerName,Long storageDays,Boolean inStock,String status,
        boolean needsReview,String reviewReason,String arrivalTimeSource,String departureTimeSource,long version) {}
    public record Issue(UUID id,UUID containerId,String containerName,String reason) {}
    private static final String SELECT="""
        select p.*,c.code container_name,a.name area_name,cl.name client_name,ow.name owner_name,
          r.number::bigint receiving_number,s.number::bigint shipping_number,r.transport_type arrival_transport,s.transport_type departure_transport,
          ic.name arrival_carrier,oc.name departure_carrier,r.consignor,cons.name consignee,
          shipping_client.name shipping_client_name,shipping_owner.name shipping_owner_name,
          ah.time_source arrival_time_source,dh.time_source departure_time_source,
          case when p.status='CANCELLED' or p.needs_review then null
            else greatest(0,(least(coalesce((p.departure_at at time zone 'Europe/Moscow')::date,?::date),?::date)
              -(p.arrival_at at time zone 'Europe/Moscow')::date)+1)::bigint end storage_days
        from container_storage_period p join container c on c.id=p.container_id
        join terminal_area_catalog a on a.id=p.terminal_area_id
        join receiving_order r on r.id=p.receiving_order_id
        left join client cl on cl.id=p.receiving_client_id left join client ow on ow.id=p.arrival_owner_id
        left join route ir on ir.id=r.route_id and r.transport_type='VEHICLE'
        left join client_related_entity ic on ic.id=ir.client_related_entity_id
        left join shipping_order s on s.id=p.shipping_order_id
        left join client shipping_client on shipping_client.id=s.client_id
        left join lateral (
          select string_agg(distinct owner.name,'; ' order by owner.name) name
          from shipping_order_container sc join client owner on owner.id=sc.owner_container_id
          where sc.shipping_order_id=p.shipping_order_id and sc.container_id=p.container_id
        ) shipping_owner on true
        left join route outr on outr.id=s.route_id and s.transport_type='VEHICLE'
        left join client_related_entity oc on oc.id=outr.client_related_entity_id
        left join client_related_entity cons on cons.id=s.consignee_id
        join container_owner_history ah on ah.id=p.arrival_history_id
        left join container_owner_history dh on dh.id=p.departure_history_id
        """;
    record Filter(String sql,List<Object> args) {}
    private Filter filter(String query,String status,UUID clientId,UUID periodId,LocalDate from,LocalDate to,LocalDate asOf) {
        if(!Set.of("ACTIVE","OPEN","CLOSED","CANCELLED","REVIEW","ALL").contains(status))
            throw bad("Неизвестное состояние хранения");
        if(from!=null && to!=null && from.isAfter(to)) throw bad("Начало периода фильтра позже окончания");

        var args=new ArrayList<Object>();args.add(asOf);args.add(asOf);
        String sql=" where (?='' or position(lower(?) in lower(c.code))>0)";
        args.add(query.trim());args.add(query.trim());
        if(clientId!=null){sql+=" and p.receiving_client_id=?";args.add(clientId);}
        if(periodId!=null){sql+=" and p.id=?";args.add(periodId);}
        if(from!=null){sql+=" and (p.arrival_at at time zone 'Europe/Moscow')::date>=?";args.add(from);}
        if(to!=null){sql+=" and (p.arrival_at at time zone 'Europe/Moscow')::date<=?";args.add(to);}
        sql+=" and (p.arrival_at at time zone 'Europe/Moscow')::date<=?";args.add(asOf);
        sql+=switch(status){case "ACTIVE"->" and p.status<>'CANCELLED'";case "REVIEW"->" and p.needs_review";
            case "ALL"->"";default->" and p.status=?";};
        if(Set.of("OPEN","CLOSED","CANCELLED").contains(status))args.add(status);
        return new Filter(sql,args);
    }
    @GetMapping
    public PagedResponse<Row> page(@RequestParam(defaultValue="")String query,@RequestParam(defaultValue="ACTIVE")String status,
            @RequestParam(required=false)UUID clientId,@RequestParam(required=false)UUID periodId,@RequestParam(required=false)LocalDate arrivalFrom,
            @RequestParam(required=false)LocalDate arrivalTo,@RequestParam(required=false)LocalDate asOf,
            @RequestParam(defaultValue="0")int page,@RequestParam(defaultValue="20")int size) {
        var f=filter(query,status,clientId,periodId,arrivalFrom,arrivalTo,date(asOf));
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        long count=jdbc.queryForObject("select count(*) from ("+SELECT+f.sql()+") q",Long.class,f.args().toArray());
        var args=new ArrayList<>(f.args());args.add(size);args.add((long)page*size);
        return PagedResponse.of(jdbc.query(SELECT+f.sql()+" order by p.arrival_at desc,p.id limit ? offset ?",
            (rs,n)->row(rs),args.toArray()),page,size,count);
    }
    public record ContainerOption(UUID id, String name) {}
    @GetMapping("/containers")
    public List<ContainerOption> containers() {
        return jdbc.query("""
            select c.id,c.code from container c
            where exists(select 1 from container_storage_period p where p.container_id=c.id)
            order by c.code,c.id
            """, (rs,n)->new ContainerOption(rs.getObject(1,UUID.class),rs.getString(2)));
    }
    @GetMapping("/issues")
    public List<Issue> issues() {
        return jdbc.query("""
            select h.id,h.container_id,c.code,h.review_reason from container_owner_history h
            join container c on c.id=h.container_id where h.needs_review order by h.created_at,h.id
            """,(rs,n)->new Issue(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),rs.getString(4)));
    }
    @GetMapping(value="/export",produces="text/csv")
    public ResponseEntity<byte[]> export(@RequestParam(defaultValue="")String query,@RequestParam(defaultValue="ACTIVE")String status,
            @RequestParam(required=false)UUID clientId,@RequestParam(required=false)UUID periodId,@RequestParam(required=false)LocalDate arrivalFrom,
            @RequestParam(required=false)LocalDate arrivalTo,@RequestParam(required=false)LocalDate asOf) {
        var f=filter(query,status,clientId,periodId,arrivalFrom,arrivalTo,date(asOf));
        var out=new StringBuilder("\uFEFF");
        csv(out,"Номер КТК","Площадка","Заявка поставки","Прибыл","Клиент заявки поставки","Собственник при приёме",
            "Транспорт поставки","Перевозчик поставки","Груз (ЕТСНГ)","Груж/порож","Заявка вывоза","Вывезен",
            "Транспорт вывоза","Перевозчик вывоза","Грузополучатель","Кол-во дней хранения","В стоке","Состояние","Проверка");
        jdbc.query(SELECT+f.sql()+" order by p.arrival_at desc,p.id",rs->{
            Row r=row(rs);csv(out,r.containerName(),r.terminalAreaName(),r.receivingOrderNumber(),format(r.arrivalAt()),r.clientName(),r.ownerName(),
                transport(r.arrivalTransport()),r.arrivalCarrier(),r.cargoName(),r.empty()==null?"Не указан":r.empty()?"Порожний":"Гружёный",
                r.shippingOrderNumber(),format(r.departureAt()),transport(r.departureTransport()),r.departureCarrier(),r.consignee(),
                r.storageDays(),r.inStock()==null?"Требует проверки":r.inStock()?"Да":"Нет",
                switch(r.status()){case "OPEN"->"На терминале";case "CLOSED"->"Вывезен";default->"Аннулирован";},r.reviewReason());
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
    private static String format(OffsetDateTime value){return value==null?"":value.atZoneSameInstant(ZoneId.of("Europe/Moscow"))
        .format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"));}
    private static String transport(String s){return s==null?"":s.equals("VEHICLE")?"Авто":s.equals("RAILWAY")?"ЖД":s;}
    private LocalDate date(LocalDate d) {
        LocalDate today=jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(d!=null && d.isAfter(today)) throw bad("Дата расчёта не может быть позже рабочей даты");
        return d==null?today:d;
    }
    private static ApiException bad(String message){return new ApiException(HttpStatus.BAD_REQUEST,"INVALID_STORAGE_FILTER",message);}
    private Row row(ResultSet rs)throws SQLException {
        String status=rs.getString("status");boolean review=rs.getBoolean("needs_review");
        return new Row(rs.getObject("id",UUID.class),rs.getObject("container_id",UUID.class),rs.getString("container_name"),rs.getString("area_name"),
            rs.getObject("receiving_order_id",UUID.class),rs.getObject("receiving_number",Long.class),rs.getObject("arrival_at",OffsetDateTime.class),
            rs.getString("client_name"),rs.getString("owner_name"),rs.getString("arrival_transport"),rs.getString("arrival_carrier"),rs.getString("consignor"),
            rs.getString("cargo_name"),rs.getObject("is_empty",Boolean.class),rs.getObject("shipping_order_id",UUID.class),
            rs.getObject("shipping_number",Long.class),rs.getObject("departure_at",OffsetDateTime.class),rs.getString("departure_transport"),
            rs.getString("departure_carrier"),rs.getString("consignee"),rs.getString("shipping_client_name"),rs.getString("shipping_owner_name"),rs.getObject("storage_days",Long.class),review?null:status.equals("OPEN"),
            status,review,rs.getString("review_reason"),rs.getString("arrival_time_source"),rs.getString("departure_time_source"),rs.getLong("version"));
    }
}
