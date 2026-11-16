package ru.billing.app.comprehensiveserviceorder;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

public final class ServiceCompletion {
    private ServiceCompletion() {}
    // Caller holds the parent service lock inside its lifecycle transaction.
    public static void refresh(JdbcTemplate jdbc, UUID serviceId) {
        jdbc.update("""
            update comprehensive_service_order s set status='COMPLETED'
            where s.id=? and s.status not in ('COMPLETED','CANCELLED')
              and not exists(select 1 from receiving_order where comprehensive_service_order_id=s.id and order_status not in ('COMPLETED','CANCELLED'))
              and not exists(select 1 from shipping_order where comprehensive_service_order_id=s.id and order_status not in ('COMPLETED','CANCELLED'))
              and ((s.workflow='RAILWAY_RETURN' and exists(select 1 from receiving_order
                    where comprehensive_service_order_id=s.id and service_role='INITIAL_RECEIVING' and order_status='COMPLETED'))
                or (s.workflow='AUTO_RETURN' and exists(select 1 from receiving_order
                    where comprehensive_service_order_id=s.id and service_role='RETURN_RECEIVING' and order_status='COMPLETED')))
              and not exists(select 1 from shipping_order_source_container link where link.comprehensive_service_order_id=s.id
                and not exists(select 1 from shipping_order_container sc join shipping_order sh on sh.id=sc.shipping_order_id
                    where sc.shipping_order_id=link.shipping_order_id and sc.container_id=link.container_id
                      and not sc.return_required and sh.order_status='COMPLETED')
                and not exists(select 1 from receiving_order r join receiving_order_container rc on rc.receiving_order_id=r.id
                    where r.source_shipping_order_id=link.shipping_order_id and r.service_role='RETURN_RECEIVING'
                      and r.order_status='COMPLETED' and rc.container_id=link.container_id))
              and not exists(select 1 from receiving_order r join waybill_details w on w.receiving_order_id=r.id
                join waybill_railway_carriage rc on rc.waybill_id=w.id
                join waybill_container_details wc on wc.waybill_railway_carriage_id=rc.id
                where r.comprehensive_service_order_id=s.id and not exists(select 1 from shipping_order_source_container link
                    where link.comprehensive_service_order_id=s.id and link.container_id=wc.container_id))
            """,serviceId);
    }
}
