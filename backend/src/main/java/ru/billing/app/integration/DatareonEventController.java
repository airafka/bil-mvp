package ru.billing.app.integration;

import jakarta.validation.Valid;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.error.ApiException;
import ru.billing.app.order.OrderStatusService;

@RestController
public class DatareonEventController {
    private static final Logger log = LoggerFactory.getLogger(DatareonEventController.class);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final OrderStatusService orders;

    public DatareonEventController(JdbcTemplate jdbc, TransactionTemplate transaction, OrderStatusService orders) {
        this.jdbc = jdbc;
        this.transaction = transaction;
        this.orders = orders;
    }

    @PostMapping("/datareon/event")
    public ResponseEntity<?> receive(@Valid @RequestBody TosEvent event,
            @RequestHeader(value="External-ID", required=false) String externalId,
            @RequestHeader(value="Prefer", defaultValue="") String prefer) {
        UUID delivery = UUID.randomUUID();
        String action = jdbc.queryForObject("select (select action_code from inbound_event_config where event_code=?)",
                String.class,event.eventCode());
        jdbc.update("""
                insert into inbound_event(id,task_id,order_id,order_number,source,site,terminal_area,event_name,event_code,
                    event_date_time,external_id,action_codes,status)
                values (?,?,?,?,?,?,(select code from terminal_area_catalog where lower(name)=lower(?)),?,?,?,?,array_remove(array[?::text], null),?)
                """, delivery,event.taskId(),event.orderId(),event.orderNumber(),event.source(),event.site(),event.site(),
                event.eventName(),event.eventCode(),event.eventDateTime(),externalId,action,action == null ? "SKIPPED" : "NEW");
        var result = action == null
                ? new Receipt("SKIPPED", "Код события не настроен для обработки")
                : process(event, action, delivery);
        return "return=representation".equalsIgnoreCase(prefer)
                ? ResponseEntity.ok(result) : ResponseEntity.ok().build();
    }

    private record Receipt(String status, String details) {}

    private Receipt process(TosEvent event, String action, UUID delivery) {
        try {
            return transaction.execute(tx -> {
                orders.finishTos(event, "TOS_RECEIVING_RESULT".equals(action));
                return recordStatus(delivery, "DONE", null);
            });
        } catch (ApiException e) {
            if (e.getSourceMessage() != null) {
                String status = e.getStatus() == org.springframework.http.HttpStatus.NOT_FOUND ? "FAILED" : "INVALID";
                return recordStatus(delivery, status, e.getSourceMessage());
            }
            return recordStatus(delivery, "INVALID", e.getCode() + " — " + e.getMessage());
        } catch (RuntimeException e) {
            log.error("Could not process TOS delivery {}", delivery, e);
            return recordStatus(delivery, "FAILED", "Ошибка обработки результата TOS");
        }
    }

    private Receipt recordStatus(UUID delivery, String status, String details) {
        jdbc.update("update inbound_event set status=?, status_details=? where id=?",status,details,delivery);
        return new Receipt(status, details);
    }
}
