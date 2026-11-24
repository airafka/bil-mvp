package ru.billing.app.integration;

import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.error.ApiException;

@RestController
@RequestMapping("/api/outbounddata")
public class OutboundDataController {
    private final JdbcTemplate jdbc;

    public OutboundDataController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PutMapping("/resend/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void resend(@PathVariable UUID id) {
        var rows = jdbc.query("""
                select success from outbound_data where id=? and entity_type='SERVICE_ORDER'
                    and message_type='SERVICE_ORDER_CHAIN_PACKAGE' for update
                """, (rs,n) -> rs.getObject(1,Boolean.class),id);
        if (rows.isEmpty()) throw new ApiException(HttpStatus.NOT_FOUND,"OUTBOUND_DATA_NOT_FOUND","Сообщение не найдено");
        if (Boolean.TRUE.equals(rows.getFirst())) {
            throw new ApiException(HttpStatus.CONFLICT,"OUTBOUND_ALREADY_SENT","Datareon уже принял этот пакет");
        }
        if (Boolean.FALSE.equals(rows.getFirst())) {
            jdbc.update("""
                    update outbound_data set attempts=0,success=null,last_attempt_at=null,error_message=null,
                        updated_at=clock_timestamp() at time zone 'UTC',updated_by='local' where id=?
                    """, id);
        }
    }
}
