package ru.billing.app.comprehensiveserviceorder;

import java.util.*;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.billing.BillingService;
import ru.billing.app.error.ApiException;

@Service
public class ServiceNoReturnService {
    public record Candidate(UUID containerId,String containerName,UUID shippingOrderId,int shippingOrderCode,
                            String shippingStatus,boolean returnRequired) {}
    public record Request(@NotEmpty @Size(max=10000) List<@NotNull UUID> containerIds) {}
    private final JdbcTemplate jdbc;
    private final BillingService billing;
    private final ComprehensiveServiceOrderService services;
    public ServiceNoReturnService(JdbcTemplate jdbc,BillingService billing,ComprehensiveServiceOrderService services) {
        this.jdbc=jdbc;this.billing=billing;this.services=services;
    }
    private void requireRailwayService(UUID id) {
        var rows=jdbc.query("select workflow,status from comprehensive_service_order where id=?",
            (rs,n)->List.of(rs.getString(1),rs.getString(2)),id);
        if(rows.isEmpty())throw new ApiException(HttpStatus.NOT_FOUND,"SERVICE_NOT_FOUND","Заявка на услугу не найдена");
        if(!"RAILWAY_RETURN".equals(rows.getFirst().getFirst()))throw conflict("RAILWAY_SERVICE_REQUIRED","Действие доступно только для ЖД-услуги");
        if("CANCELLED".equals(rows.getFirst().get(1)))throw conflict("SERVICE_CANCELLED","Заявка на услугу отменена");
    }
    @Transactional(readOnly=true)
    public List<Candidate> candidates(UUID id) {
        requireRailwayService(id);
        return jdbc.query("""
            select c.id,c.code,sh.id,sh.number,sh.order_status,sc.return_required
            from shipping_order_source_container link
            join shipping_order sh on sh.id=link.shipping_order_id
            join shipping_order_container sc on sc.shipping_order_id=sh.id and sc.container_id=link.container_id
            join container c on c.id=link.container_id
            where link.comprehensive_service_order_id=? and sh.order_status<>'CANCELLED' and sh.transport_type='VEHICLE'
              and not exists(select 1 from receiving_order_container rc
                where rc.source_shipping_order_id=sh.id and rc.container_id=c.id)
            order by sh.number,c.code,c.id
            """,(rs,n)->new Candidate(rs.getObject(1,UUID.class),rs.getString(2),rs.getObject(3,UUID.class),rs.getInt(4),rs.getString(5),rs.getBoolean(6)),id);
    }
    @Transactional
    public ComprehensiveServiceOrderDetails select(UUID id,Request request) {
        ServiceOrderLock.lock(jdbc,id);
        requireRailwayService(id);
        var selected=new HashSet<>(request.containerIds());
        if(selected.size()!=request.containerIds().size())throw conflict("DUPLICATE_CONTAINER","КТК указан повторно");
        var available=candidates(id).stream().filter(c->selected.contains(c.containerId())).toList();
        if(available.size()!=selected.size())throw conflict("NO_RETURN_CONTAINERS_UNAVAILABLE",
            "Часть КТК уже имеет возврат, вывоз отменён или КТК не относится к этой услуге. Обновите список.");
        // Same parent lock as return creation, shipping completion and cancellation; the batch is atomic.
        for(var row:available) jdbc.update("update shipping_order_container set return_required=false where shipping_order_id=? and container_id=?",row.shippingOrderId(),row.containerId());
        available.stream().filter(c->"COMPLETED".equals(c.shippingStatus())).map(Candidate::shippingOrderId).distinct().sorted()
            .forEach(billing::completeShipping);
        ServiceCompletion.refresh(jdbc,id);
        return services.findById(id);
    }
    private static ApiException conflict(String code,String message){return new ApiException(HttpStatus.CONFLICT,code,message);}
}
