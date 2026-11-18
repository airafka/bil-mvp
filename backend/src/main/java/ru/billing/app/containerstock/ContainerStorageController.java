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
    public record Row(UUID id,UUID containerId,String containerName,
        String ownerName,OffsetDateTime arrivalAt,OffsetDateTime departureAt,String status,
        UUID startOrderId,String startOrderType,Long startOrderNumber,UUID endOrderId,String endOrderType,Long endOrderNumber) {}
    private static final String FROM="""
        from container_storage_period p
        join container_owner_history h on h.id=p.start_history_id
        join container c on c.id=p.container_id
        """;
    private static final String SELECT="""
        select p.id,p.container_id,c.code container_name,ow.name owner_name,
          h.occurred_at receiving_at,e.occurred_at shipping_at,p.status,
          h.order_id start_order_id,h.order_type start_order_type,
          case h.order_type when 'RECEIVING_ORDER' then r.number when 'SERVICE_ORDER' then so.number end::bigint start_order_number,
          e.order_id end_order_id,e.order_type end_order_type,
          case e.order_type when 'SHIPPING_ORDER' then s.number when 'SERVICE_ORDER' then eo.number end::bigint end_order_number
        """+FROM+"""
        left join container_owner_history e on e.id=p.end_history_id
        left join client ow on ow.id=h.new_client_id
        left join receiving_order r on r.id=h.order_id and h.order_type='RECEIVING_ORDER'
        left join service_order so on so.id=h.order_id and h.order_type='SERVICE_ORDER'
        left join shipping_order s on s.id=e.order_id and e.order_type='SHIPPING_ORDER'
        left join service_order eo on eo.id=e.order_id and e.order_type='SERVICE_ORDER'
        """;
    record Filter(String sql,List<Object> args) {}
    private Filter filter(String query,String status,UUID clientId,UUID periodId,LocalDate from,LocalDate to,LocalDate asOf) {
        if(!Set.of("ACTIVE","OPEN","CLOSED","CANCELLED","ALL").contains(status))
            throw bad("Неизвестное состояние хранения");
        if(from!=null && to!=null && from.isAfter(to)) throw bad("Начало периода фильтра позже окончания");

        var args=new ArrayList<Object>();
        String sql=" where p.status in ('OPEN','CLOSED') and (?='' or position(lower(?) in lower(c.code))>0)";
        args.add(query.trim());args.add(query.trim());
        // Retain the legacy client filter; only this optional filter needs the original arrival chain.
        if(clientId!=null){sql+=" and exists(select 1 from container_storage_period_origin o join receiving_order r on r.id=o.receiving_order_id where o.id=p.id and r.client_id=?)";args.add(clientId);}
        if(periodId!=null){sql+=" and p.id=?";args.add(periodId);}
        if(from!=null){sql+=" and (h.occurred_at at time zone 'Europe/Moscow')::date>=?";args.add(from);}
        if(to!=null){sql+=" and (h.occurred_at at time zone 'Europe/Moscow')::date<=?";args.add(to);}
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
        var f=filter(query,status,clientId,periodId,arrivalFrom,arrivalTo,date(asOf));
        page=Math.max(0,page);size=Math.max(1,Math.min(100,size));
        long count=jdbc.queryForObject("select count(*) "+FROM+f.sql(),Long.class,f.args().toArray());
        var args=new ArrayList<>(f.args());args.add(size);args.add((long)page*size);
        return PagedResponse.of(jdbc.query(SELECT+f.sql()+" order by h.occurred_at desc,p.id limit ? offset ?",
            (rs,n)->row(rs),args.toArray()),page,size,count);
    }
    public record ContainerOption(UUID id, String name) {}
    @GetMapping("/containers")
    public List<ContainerOption> containers() {
        return jdbc.query("""
            select c.id,c.code from container c
            where exists(select 1 from container_storage_period p where p.container_id=c.id and p.status in ('OPEN','CLOSED'))
            order by c.code,c.id
            """, (rs,n)->new ContainerOption(rs.getObject(1,UUID.class),rs.getString(2)));
    }
    @GetMapping(value="/export",produces="text/csv")
    public ResponseEntity<byte[]> export(@RequestParam(defaultValue="")String query,@RequestParam(defaultValue="ACTIVE")String status,
            @RequestParam(required=false)UUID clientId,@RequestParam(required=false)UUID periodId,@RequestParam(required=false)LocalDate arrivalFrom,
            @RequestParam(required=false)LocalDate arrivalTo,@RequestParam(required=false)LocalDate asOf) {
        var f=filter(query,status,clientId,periodId,arrivalFrom,arrivalTo,date(asOf));
        var out=new StringBuilder("\uFEFF");
        csv(out,"Номер КТК","Собственник КТК","Начало периода","Тип начала","Номер заявки начала",
            "Окончание периода","Тип окончания","Номер заявки окончания","Статус хранения");
        jdbc.query(SELECT+f.sql()+" order by h.occurred_at desc,p.id",rs->{
            Row r=row(rs);csv(out,r.containerName(),r.ownerName(),format(r.arrivalAt()),boundary(r.startOrderType()),r.startOrderNumber(),
                format(r.departureAt()),boundary(r.endOrderType()),r.endOrderNumber(),r.status().equals("OPEN")?"Открыт":"Закрыт");
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
    private static String boundary(String s){return s==null?"":switch(s){case "RECEIVING_ORDER"->"Поставка";case "SHIPPING_ORDER"->"Вывоз";case "SERVICE_ORDER"->"Смена собственника";default->s;};}
    private LocalDate date(LocalDate d) {
        LocalDate today=jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(d!=null && d.isAfter(today)) throw bad("Дата расчёта не может быть позже рабочей даты");
        return d==null?today:d;
    }
    private static ApiException bad(String message){return new ApiException(HttpStatus.BAD_REQUEST,"INVALID_STORAGE_FILTER",message);}
    private Row row(ResultSet rs)throws SQLException {
        String status=rs.getString("status");
        return new Row(rs.getObject("id",UUID.class),rs.getObject("container_id",UUID.class),rs.getString("container_name"),
            rs.getString("owner_name"),rs.getObject("receiving_at",OffsetDateTime.class),rs.getObject("shipping_at",OffsetDateTime.class),status,
            rs.getObject("start_order_id",UUID.class),rs.getString("start_order_type"),rs.getObject("start_order_number",Long.class),
            rs.getObject("end_order_id",UUID.class),rs.getString("end_order_type"),rs.getObject("end_order_number",Long.class));
    }
}
