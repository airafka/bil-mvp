package ru.billing.app.containerstock;

import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import ru.billing.app.error.ApiException;

/** Document-row tasks. Called inside the transaction holding the order and physical KTK locks. */
@Service
public class ContainerTaskRows {
    private final JdbcTemplate jdbc;
    public ContainerTaskRows(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    public record Row(UUID id,UUID container,UUID owner,String status,String table,String code) {}

    public List<Row> rows(UUID order,boolean receiving) {
        return rows(order, receiving, false);
    }

    List<Row> rowsForStockOperation(UUID order, boolean receiving) {
        return rows(order, receiving, receiving);
    }

    private List<Row> rows(UUID order, boolean receiving, boolean validateOwners) {
        boolean railway=receiving && "RAILWAY".equals(jdbc.queryForObject(
            "select transport_type from receiving_order where id=?",String.class,order));
        String table=railway?"waybill_container":receiving?"receiving_order_container":"shipping_order_container";
        String query=railway?"""
            select wc.id,wc.container_id,wc.owner_container_id,wc.status,c.code
            from waybill w join waybill_railway_carriage wr on wr.waybill_id=w.id
            join waybill_container wc on wc.waybill_railway_carriage_id=wr.id
            join container c on c.id=wc.container_id
            where w.receiving_order_id=? order by wc.container_id,wc.id
            """:"select r.id,r.container_id,r."+(receiving?"owner_container_id":"container_owner_id")+",r.status,c.code from "+table+" r join container c on c.id=r.container_id where r."
                +(receiving?"receiving_order_id":"shipping_order_id")+"=? order by r.container_id,r.id";
        var rows=jdbc.query(query,(rs,n)->new Row(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),
            rs.getObject(3,UUID.class),rs.getString(4),table,rs.getString(5)),order);
        if(receiving && !railway && rows.isEmpty() && Boolean.TRUE.equals(jdbc.queryForObject("""
            select exists(select 1 from waybill w join waybill_railway_carriage wr on wr.waybill_id=w.id
              join waybill_container wc on wc.waybill_railway_carriage_id=wr.id where w.receiving_order_id=?)
            """,Boolean.class,order)))
            throw conflict("RECEIVING_OWNER_REQUIRED","Укажите собственников КТК в заявке на поставку");
        if (validateOwners) validateReceivingOwners(rows);
        var seen=new HashSet<UUID>();
        for(var row:rows) if(!seen.add(row.container())) throw conflict(
            "CONTAINER_TASK_AMBIGUOUS","В заявке несколько строк одного КТК. Для фактического выполнения нужна однозначная строка");
        return rows;
    }

    static void validateReceivingOwners(List<Row> rows) {
        var owners = new HashMap<UUID, UUID>();
        var conflicts = new StockViolations();
        for (var row : rows) {
            String reason;
            if (row.owner() == null) {
                reason = "Не заполнен собственник КТК";
            } else {
                var previous = owners.putIfAbsent(row.container(), row.owner());
                if (previous == null || previous.equals(row.owner())) continue;
                reason = "Для КТК указаны разные собственники";
            }
            conflicts.add(reason, null, row.code(), reason);
        }
        if (!conflicts.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "CONTAINER_RESERVATION_CONFLICT",
                conflicts.detail(), conflicts.originalMessage());
    }

    public void change(Row row,String expected,String status) {
        if(!Objects.equals(row.status(),expected) || jdbc.update("update "+row.table()
            +" set status=? where id=? and status is not distinct from ?::varchar",status,row.id(),expected)!=1)
            throw conflict("CONTAINER_TASK_STATUS_CHANGED","Статус строки КТК не соответствует операции. Обновите заявку");
    }

    public Row finished(UUID order,UUID container,boolean receiving) {
        var rows=rows(order,receiving).stream().filter(r->r.container().equals(container)).toList();
        if(rows.size()!=1 || !"FINISHED".equals(rows.getFirst().status()))
            throw conflict("CONTAINER_TASK_NOT_FINISHED","Для периода хранения нужна выполненная строка КТК");
        return rows.getFirst();
    }

    private ApiException conflict(String code,String message) {return new ApiException(HttpStatus.CONFLICT,code,message);}
}
