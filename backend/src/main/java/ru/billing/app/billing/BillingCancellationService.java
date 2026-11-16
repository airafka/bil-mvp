package ru.billing.app.billing;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;

@Service
public class BillingCancellationService {
    private final JdbcTemplate jdbc;
    public BillingCancellationService(JdbcTemplate jdbc){this.jdbc=jdbc;}
    @Transactional(propagation=Propagation.MANDATORY)
    public void cancel(String resource, UUID orderId) {
        String predicate = switch(resource) {
            case "receiving-orders" -> "receiving_order_id=?";
            case "shipping-orders" -> "shipping_order_id=? and receiving_order_id is null";
            default -> throw new IllegalArgumentException("Unsupported billing resource: "+resource);
        };
        // Invoice creation also locks charges by id before checking availability.
        jdbc.query("""
            select b.id from billing_charge b join service_execution e on e.id=b.service_execution_id
            where %s order by b.id for update of b
            """.formatted(predicate),(rs,n)->rs.getObject(1,UUID.class),orderId);
        var invoices=jdbc.query("""
            select distinct i.code from payment_invoice i join payment_invoice_line l on l.invoice_id=i.id
            join billing_charge b on b.id=l.billing_charge_id join service_execution e on e.id=b.service_execution_id
            where %s order by i.code
            """.formatted(predicate),(rs,n)->rs.getString(1),orderId);
        if(!invoices.isEmpty())throw new ApiException(HttpStatus.CONFLICT,"CANCELLATION_INVOICED",
            "Начисления включены в счета №"+String.join(", ",invoices)+". Исключите их из чернового счёта перед отменой. Оплаченные счета изменять нельзя");
        // Preserve the exact execution and tariff/charge amounts in the cancellation audit.
        jdbc.update("""
            update order_cancellation set billing_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
                'execution',to_jsonb(e),'charge',to_jsonb(b))),'[]'::jsonb)
                from service_execution e left join billing_charge b on b.service_execution_id=e.id where %s)
            where resource=? and order_id=?
            """.formatted(predicate),orderId,resource,orderId);
        jdbc.update("delete from billing_charge where service_execution_id in (select id from service_execution where "+predicate+")",orderId);
        jdbc.update("delete from service_execution where "+predicate,orderId);
    }
}
