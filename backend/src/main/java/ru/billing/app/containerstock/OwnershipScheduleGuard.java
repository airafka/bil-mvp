package ru.billing.app.containerstock;

import java.time.LocalDate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;

final class OwnershipScheduleGuard {
    private OwnershipScheduleGuard() {}
    // Inside a read transaction the business-clock lock is retained until the response is built.
    static void requireCurrent(JdbcTemplate jdbc) {
        LocalDate today=jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from service_order where status='SCHEDULED' and effective_date<=? and exists(select 1 from service_order_container sc where sc.service_order_id=service_order.id and sc.result_status in ('PLANNED','BLOCKED')))",Boolean.class,today)))
            throw new ApiException(HttpStatus.CONFLICT,"OWNERSHIP_SCHEDULE_PENDING","Есть наступившая смена собственника, которую не удалось выполнить. Проверьте ожидающие заявки на смену собственника");
    }
}
