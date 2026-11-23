package ru.billing.app.containerstock;

import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.error.ApiException;
import ru.billing.app.reference.ReferenceOption;

@RestController
public class ShipmentStockController {
    private final JdbcTemplate jdbc;
    public ShipmentStockController(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    public record Owner(UUID id,String name,long available) {}
    @GetMapping("/api/references/container-stock-owners")
    @Transactional
    public List<Owner> containerOwners(@RequestParam(required=false) String type) {
        jdbc.queryForObject("select refresh_container_owner_clients()",Integer.class);
        return owners("""
                select o.client_id, count(*) n from container_owner_current o join container c on c.id=o.container_id
                where o.status='ON_TERMINAL' and (?::text is null or c.container_type=?) group by o.client_id
                """,type);
    }
    @GetMapping("/api/references/carriage-stock-owners")
    public List<Owner> carriageOwners(@RequestParam(required=false) UUID type) {
        return owners("""
                select o.client_owner_id as client_id,count(*) n from railway_carriage_owner o join railway_carriage c on c.id=o.railway_carriage_id
                where o.status='ON_TERMINAL' and (?::uuid is null or c.type_id=?) group by o.client_owner_id
                """,type);
    }
    private List<Owner> owners(String counts,Object type) {
        return jdbc.query("select c.id,c.name,coalesce(s.n,0) n from client c left join ("+counts+
                ") s on s.client_id=c.id order by n desc,c.name,c.id",
                (rs,n)->new Owner(rs.getObject(1,UUID.class),rs.getString(2),rs.getLong(3)),type,type);
    }
    @GetMapping("/api/shipping-orders/{order}/available-wagons")
    public List<ReferenceOption> available(@PathVariable UUID order,@RequestParam(defaultValue="") String q) {
        return jdbc.query("""
                select c.id,c.code from railway_carriage c where position(lower(?) in lower(c.code))>0 and (
                    exists(select 1 from shipping_order_railway_carriage s where s.shipping_order_id=? and s.railway_carriage_id=c.id)
                    or exists(select 1 from railway_carriage_owner o join shipping_order_railway_carriage_qty p
                        on p.shipping_order_id=? and p.owner_railway_carriage_id=o.client_owner_id and p.type_id=c.type_id
                        where o.railway_carriage_id=c.id and o.status='ON_TERMINAL' and p.quantity>(
                            select count(*) from shipping_order_railway_carriage s join railway_carriage used on used.id=s.railway_carriage_id
                            where s.shipping_order_id=p.shipping_order_id and s.owner_railway_carriage_id=p.owner_railway_carriage_id
                            and used.type_id=p.type_id)))
                order by c.code limit 100
                """,(rs,n)->new ReferenceOption(rs.getObject(1,UUID.class),rs.getString(2)),q,order,order);
    }
    public record ReceiptWagon(UUID id,String code, UUID ownerId,String ownerName) {}
    @GetMapping("/api/receiving-orders/{order}/wagon-owners")
    public List<ReceiptWagon> receiptWagons(@PathVariable UUID order) {
        return jdbc.query("""
                select distinct c.id,c.code,cl.id,cl.name from waybill w join receiving_order r on r.id=w.receiving_order_id
                join waybill_railway_carriage wr on wr.waybill_id=w.id join railway_carriage c on c.id=wr.railway_carriage_id
                left join client cl on cl.id=coalesce(wr.owner_railway_carriage_id,r.default_railway_carriage_owner_id,r.client_id)
                where r.id=? order by c.code
                """,(rs,n)->new ReceiptWagon(rs.getObject(1,UUID.class),rs.getString(2),rs.getObject(3,UUID.class),rs.getString(4)),order);
    }
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PutMapping("/api/shipping-orders/{order}/plan/{kind}/{row}/owner")
    @Transactional
    public void setPlanOwner(@PathVariable UUID order,@PathVariable String kind,@PathVariable UUID row,
            @jakarta.validation.Valid @RequestBody OwnerChoice choice) {
        var status=jdbc.queryForList("select order_status from shipping_order where id=? for update",String.class,order);
        if (!status.equals(List.of("DRAFT"))) throw new ApiException(HttpStatus.CONFLICT,"ORDER_NOT_DRAFT","Изменить план можно в черновике вывоза");
        String query=switch(kind) {
            case "containers" -> "update shipping_order_container_qty set owner_client_id=?";
            case "wagons" -> "update shipping_order_railway_carriage_qty set owner_railway_carriage_id=?,type_id=coalesce(?::uuid,type_id)";
            default -> throw new ApiException(HttpStatus.BAD_REQUEST,"INVALID_PLAN","Неизвестная группа плана");
        };
        query+=" where shipping_order_id=? and id=? and exists(select 1 from client where id=?)";
        int changed=kind.equals("wagons")
                ? jdbc.update(query,choice.ownerId(),choice.typeId(),order,row,choice.ownerId())
                : jdbc.update(query,choice.ownerId(),order,row,choice.ownerId());
        if (changed!=1) throw new ApiException(HttpStatus.BAD_REQUEST,"INVALID_PLAN","Строка плана или собственник не найдены");
    }
    public record OwnerChoice(@jakarta.validation.constraints.NotNull UUID ownerId, UUID typeId) {}
    @PutMapping("/api/receiving-orders/{order}/wagons/{wagon}/owner")
    @Transactional
    public List<ReceiptWagon> setWagonOwner(@PathVariable UUID order,@PathVariable UUID wagon,@jakarta.validation.Valid @RequestBody OwnerChoice choice) {
        var status=jdbc.queryForList("select order_status from receiving_order where id=? for update",String.class,order);
        if (!status.equals(List.of("DRAFT"))) throw new ApiException(HttpStatus.CONFLICT,"ORDER_NOT_DRAFT","Изменить собственника можно в черновике поставки");
        if (jdbc.update("""
                update waybill_railway_carriage wr set owner_railway_carriage_id=? from waybill w
                where w.id=wr.waybill_id and w.receiving_order_id=? and wr.railway_carriage_id=?
                and exists(select 1 from client where id=?)
                """,choice.ownerId(),order,wagon,choice.ownerId())==0)
            throw new ApiException(HttpStatus.BAD_REQUEST,"INVALID_WAGON_OWNER","Вагон или собственник не найдены в поставке");
        return receiptWagons(order);
    }
}
