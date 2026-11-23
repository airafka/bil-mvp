package ru.billing.app.containerstock;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import ru.billing.app.error.ApiException;

@Service
public class RailwayCarriageStock {
    private final JdbcTemplate jdbc;
    public RailwayCarriageStock(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    private record Wagon(UUID id, UUID owner, UUID type, String code, String status) {}
    private static final String WAGON = """
            select c.id, o.client_owner_id, c.type_id, c.code, o.status from railway_carriage c
            left join railway_carriage_owner o on o.railway_carriage_id=c.id
            """;
    private List<Wagon> wagons(String where, UUID id) {
        // Lock the directory rows even for a wagon that has no stock history yet.
        // Read the view in a separate statement after acquiring the locks.
        jdbc.queryForList("select c.id from railway_carriage c where " + where + " order by c.id for update", UUID.class,id);
        return jdbc.query(WAGON+" where "+where+" order by c.id",(rs,n)->new Wagon(
                rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getObject(3,UUID.class),rs.getString(4),rs.getString(5)),id);
    }
    private static final String RECEIPTS = """
            c.id in (select wr.railway_carriage_id from waybill_railway_carriage wr
            join waybill w on w.id=wr.waybill_id where w.receiving_order_id=?)
            """;
    private static final String SHIPMENTS = "c.id in (select railway_carriage_id from shipping_order_railway_carriage where shipping_order_id=?)";

    public void confirm(boolean receiving, UUID id) {
        if (receiving) {
            for (var wagon : wagons(RECEIPTS,id)) {
                if (wagon.status()!=null && !"DEPARTED".equals(wagon.status()))
                    throw invalid("Вагон "+wagon.code()+" уже на терминале или зарезервирован");
                var owners = jdbc.queryForList("""
                        select distinct coalesce(wr.owner_railway_carriage_id,r.default_railway_carriage_owner_id,r.client_id)
                        from waybill_railway_carriage wr join waybill w on w.id=wr.waybill_id
                        join receiving_order r on r.id=w.receiving_order_id where r.id=? and wr.railway_carriage_id=?
                        """,UUID.class,id,wagon.id());
                if (owners.size()!=1 || owners.getFirst()==null) throw invalid("Укажите одного собственника вагона "+wagon.code()+" в поставке");
                record(wagon.id(),owners.getFirst(),id,null,"EXPECTED",null);
            }
            return;
        }
        var mode=jdbc.queryForObject("select filling_type from shipping_order where id=?",String.class,id);
        if ("NONE_CONTAINER".equals(mode)) {
            checkAutoPlan(id);
        } else {
            for (var wagon : wagons(SHIPMENTS,id)) {
                available(wagon);
                record(wagon.id(),wagon.owner(),null,id,"RESERVED_OUT",null);
                jdbc.update("update shipping_order_railway_carriage set owner_railway_carriage_id=? where shipping_order_id=? and railway_carriage_id=?",wagon.owner(),id,wagon.id());
            }
        }
    }

    private void checkAutoPlan(UUID order) {
        var plans=jdbc.query("select owner_client_id,type,quantity,empty from shipping_order_container_qty where shipping_order_id=?",
                (rs,n)->new AutoPlan(rs.getObject(1,UUID.class),rs.getString(2),rs.getInt(3),rs.getBoolean(4)),order);
        if (plans.size()!=1 || plans.getFirst().quantity()!=1 || !plans.getFirst().empty()) throw invalid("Для безномерного автовывоза укажите один порожний КТК");
        var plan=plans.getFirst();
        if (plan.owner()==null) throw invalid("Укажите собственника КТК");
        jdbc.queryForObject("select refresh_container_owner_clients()",Integer.class);
        var types=jdbc.queryForList("""
                select distinct c.container_type from container_owner_current o join container c on c.id=o.container_id
                where o.client_id=? and o.status='ON_TERMINAL'
                """,String.class,plan.owner());
        if (types.isEmpty()) throw invalid("У выбранного собственника нет свободных КТК на терминале");
        if (!types.contains(plan.type())) throw invalid("У выбранного собственника нет свободного КТК нужного типоразмера");
    }
    private record AutoPlan(UUID owner, String type, int quantity, boolean empty) {}

    private void available(Wagon wagon) {
        if (!"ON_TERMINAL".equals(wagon.status())) throw invalid("Вагон "+wagon.code()+" отсутствует в свободных остатках терминала");
    }
    public void complete(boolean receiving, UUID order) {
        String field=receiving?"receiving_order_id":"shipping_order_id";
        String before=receiving?"EXPECTED":"RESERVED_OUT";
        jdbc.update("""
                insert into railway_carriage_owner_history(railway_carriage_id,client_owner_id,receiving_order_id,shipping_order_id,status)
                select railway_carriage_id,client_owner_id,receiving_order_id,shipping_order_id,?
                from railway_carriage_owner where %s=? and status=?
                """.formatted(field),receiving?"ON_TERMINAL":"DEPARTED",order,before);
    }
    public void checkCancellation(boolean receiving, UUID order) {
        String field=receiving?"receiving_order_id":"shipping_order_id";
        for (var wagon : wagons("c.id in (select railway_carriage_id from railway_carriage_owner_history where "+field+"=?)",order)) {
            var latest=jdbc.queryForObject("select "+field+" from railway_carriage_owner where railway_carriage_id=?",UUID.class,wagon.id());
            if (!Objects.equals(latest,order)) throw invalid("Сначала отмените последующую операцию по вагону "+wagon.code());
        }
    }
    private void record(UUID carriage,UUID client,UUID receiving,UUID shipping,String status,OffsetDateTime at) {
        jdbc.update("""
                insert into railway_carriage_owner_history(railway_carriage_id,client_owner_id,receiving_order_id,shipping_order_id,status,occurred_at)
                values (?,?,?,?,?,coalesce(?::timestamptz,billing_now()))
                """,carriage,client,receiving,shipping,status,at);
    }
    private ApiException invalid(String message) { return new ApiException(HttpStatus.CONFLICT,"SHIPPING_STOCK_CONFLICT",message); }
}
