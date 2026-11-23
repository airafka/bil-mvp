package ru.billing.app.integration;

import jakarta.validation.Valid;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
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
    public void receive(@Valid @RequestBody TosEvent event,
            @RequestHeader(value="External-ID", required=false) String externalId) {
        UUID delivery = UUID.randomUUID();
        String action = jdbc.queryForObject("select (select action_code from inbound_event_config where event_code=?)",
                String.class,event.eventCode());
        jdbc.update("""
                insert into inbound_event(id,task_id,order_id,order_number,source,site,event_name,event_code,
                    event_date_time,external_id,action_code,status) values (?,?,?,?,?,?,?,?,?,?,?,?)
                """, delivery,event.taskId(),event.orderId(),event.orderNumber(),event.source(),event.site(),
                event.eventName(),event.eventCode(),event.eventDateTime(),externalId,action,action == null ? "SKIPPED" : "NEW");
        if (action == null) return;
        try {
            transaction.executeWithoutResult(tx -> {
                orders.finishTos(event, "TOS_RECEIVING_RESULT".equals(action));
                recordStatus(delivery, "DONE", null);
            });
        } catch (ApiException e) {
            recordStatus(delivery, "INVALID", e.getCode() + " — " + e.getMessage());
        } catch (RuntimeException e) {
            log.error("Could not process TOS delivery {}", delivery, e);
            recordStatus(delivery, "FAILED", "Ошибка обработки результата TOS");
        }
    }

    private void recordStatus(UUID delivery, String status, String details) {
        jdbc.update("update inbound_event set status=?, status_details=? where id=?",status,details,delivery);
    }
}
