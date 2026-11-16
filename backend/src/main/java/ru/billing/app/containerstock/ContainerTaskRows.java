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
    public record Row(UUID id,UUID container,UUID owner,String status,String table) {}

    public List<Row> rows(UUID order,boolean receiving) {
        boolean railway=receiving && "RAILWAY".equals(jdbc.queryForObject(
            "select transport_type from receiving_order where id=?",String.class,order));
        String table=railway?"waybill_container":receiving?"receiving_order_container":"shipping_order_container";
        String query=railway?"""
            select wc.id,wc.container_id,wc.owner_container_id,wc.status
            from waybill w join waybill_railway_carriage wr on wr.waybill_id=w.id
            join waybill_container wc on wc.waybill_railway_carriage_id=wr.id
            where w.receiving_order_id=? order by wc.container_id,wc.id
            """:"select id,container_id,owner_container_id,status from "+table+" where "
                +(receiving?"receiving_order_id":"shipping_order_id")+"=? order by container_id,id";
        var rows=jdbc.query(query,(rs,n)->new Row(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),
            rs.getObject(3,UUID.class),rs.getString(4),table),order);
        var seen=new HashSet<UUID>();
        for(var row:rows) if(!seen.add(row.container())) throw conflict(
            "CONTAINER_TASK_AMBIGUOUS","В заявке несколько строк одного КТК. Для фактического выполнения нужна однозначная строка");
        return rows;
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

    public void cancel(UUID order,boolean receiving,String previousOrderStatus) {
        String expected="COMPLETED".equals(previousOrderStatus)?"FINISHED":"UPLOADED";
        for(var row:rows(order,receiving)) change(row,expected,null);
    }

    private ApiException conflict(String code,String message) {return new ApiException(HttpStatus.CONFLICT,code,message);}
}
