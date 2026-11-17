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
        UUID receivingOrderId,Long receivingOrderNumber,OffsetDateTime arrivalAt,String clientName,String ownerName,
        String arrivalTransport,String arrivalCarrier,String consignor,String cargoName,Boolean empty,
        UUID shippingOrderId,Long shippingOrderNumber,OffsetDateTime departureAt,String departureTransport,
        String departureCarrier,String consignee,String shippingClientName,String shippingOwnerName,Long storageDays,Boolean inStock,String status,
        UUID receivingOrderContainerId,UUID waybillContainerId,UUID shippingOrderContainerId,
        String arrivalOperationType,String departureOperationType,
        UUID startOrderId,String startOrderType,Long startOrderNumber,UUID endOrderId,String endOrderType,Long endOrderNumber) {}
    private static final String SELECT="""
        select p.*,
          greatest(0,(least(coalesce((p.shipping_at at time zone 'Europe/Moscow')::date
            - case when p.departure_operation_type='OWNER_CHANGE' then 1 else 0 end,?::date),?::date)
            -(p.receiving_at at time zone 'Europe/Moscow')::date)+1)::bigint storage_days
        from container_storage_period_view p
        """;
    record Filter(String sql,List<Object> args) {}
    private Filter filter(String query,String status,UUID clientId,UUID periodId,LocalDate from,LocalDate to,LocalDate asOf) {
        if(!Set.of("ACTIVE","OPEN","CLOSED","CANCELLED","ALL").contains(status))
            throw bad("Неизвестное состояние хранения");
        if(from!=null && to!=null && from.isAfter(to)) throw bad("Начало периода фильтра позже окончания");

        var args=new ArrayList<Object>();args.add(asOf);args.add(asOf);
        String sql=" where (?='' or position(lower(?) in lower(p.container_name))>0)";
        args.add(query.trim());args.add(query.trim());
        if(clientId!=null){sql+=" and p.receiving_client_id=?";args.add(clientId);}
        if(periodId!=null){sql+=" and p.id=?";args.add(periodId);}
        if(from!=null){sql+=" and (p.receiving_at at time zone 'Europe/Moscow')::date>=?";args.add(from);}
        if(to!=null){sql+=" and (p.receiving_at at time zone 'Europe/Moscow')::date<=?";args.add(to);}
        sql+=" and (p.receiving_at at time zone 'Europe/Moscow')::date<=?";args.add(asOf);
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
        long count=jdbc.queryForObject("select count(*) from ("+SELECT+f.sql()+") q",Long.class,f.args().toArray());
        var args=new ArrayList<>(f.args());args.add(size);args.add((long)page*size);
        return PagedResponse.of(jdbc.query(SELECT+f.sql()+" order by p.receiving_at desc,p.id limit ? offset ?",
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
        csv(out,"Номер КТК","Заявка поставки","Начало периода","Основание начала","Клиент заявки поставки","Собственник периода",
            "Транспорт поставки","Перевозчик поставки","Груз (ЕТСНГ)","Груж/порож","Заявка вывоза","Окончание периода","Основание окончания",
            "Транспорт вывоза","Перевозчик вывоза","Грузополучатель","Кол-во дней хранения","Период открыт","Состояние","Заявка начала: тип","Заявка начала: номер","Заявка окончания: тип","Заявка окончания: номер");
        jdbc.query(SELECT+f.sql()+" order by p.receiving_at desc,p.id",rs->{
            Row r=row(rs);csv(out,r.containerName(),r.receivingOrderNumber(),format(r.arrivalAt()),boundary(r.arrivalOperationType()),r.clientName(),r.ownerName(),
                transport(r.arrivalTransport()),r.arrivalCarrier(),r.cargoName(),r.empty()==null?"Не указан":r.empty()?"Порожний":"Гружёный",
                r.shippingOrderNumber(),format(r.departureAt()),boundary(r.departureOperationType()),transport(r.departureTransport()),r.departureCarrier(),r.consignee(),
                r.storageDays(),r.inStock()?"Да":"Нет",
                switch(r.status()){case "OPEN"->"Открыт";case "CLOSED"->"Завершён";default->"Аннулирован";},
                boundary(r.arrivalOperationType()),r.startOrderNumber(),boundary(r.departureOperationType()),r.endOrderNumber());
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
    private static String boundary(String s){return s==null?"":switch(s){case "ARRIVAL"->"Приём";case "DEPARTURE"->"Вывоз";case "OWNER_CHANGE"->"Смена собственника";default->s;};}
    private LocalDate date(LocalDate d) {
        LocalDate today=jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(d!=null && d.isAfter(today)) throw bad("Дата расчёта не может быть позже рабочей даты");
        return d==null?today:d;
    }
    private static ApiException bad(String message){return new ApiException(HttpStatus.BAD_REQUEST,"INVALID_STORAGE_FILTER",message);}
    private Row row(ResultSet rs)throws SQLException {
        String status=rs.getString("status");
        return new Row(rs.getObject("id",UUID.class),rs.getObject("container_id",UUID.class),rs.getString("container_name"),
            rs.getObject("receiving_order_id",UUID.class),rs.getObject("receiving_number",Long.class),rs.getObject("receiving_at",OffsetDateTime.class),
            rs.getString("client_name"),rs.getString("owner_name"),rs.getString("arrival_transport"),rs.getString("arrival_carrier"),rs.getString("consignor"),
            rs.getString("cargo_name"),rs.getObject("is_empty",Boolean.class),rs.getObject("shipping_order_id",UUID.class),
            rs.getObject("shipping_number",Long.class),rs.getObject("shipping_at",OffsetDateTime.class),rs.getString("departure_transport"),
            rs.getString("departure_carrier"),rs.getString("consignee"),rs.getString("shipping_client_name"),rs.getString("shipping_owner_name"),rs.getObject("storage_days",Long.class),status.equals("OPEN"),
            status,rs.getObject("receiving_order_container_id",UUID.class),
            rs.getObject("waybill_container_id",UUID.class),rs.getObject("shipping_order_container_id",UUID.class),
            rs.getString("arrival_operation_type"),rs.getString("departure_operation_type"),
            rs.getObject("start_order_id",UUID.class),rs.getString("start_order_type"),rs.getObject("start_order_number",Long.class),
            rs.getObject("end_order_id",UUID.class),rs.getString("end_order_type"),rs.getObject("end_order_number",Long.class));
    }
}
