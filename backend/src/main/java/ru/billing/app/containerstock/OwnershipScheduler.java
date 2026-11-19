package ru.billing.app.containerstock;

import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@EnableScheduling
public class OwnershipScheduler {
    private static final Logger log=LoggerFactory.getLogger(OwnershipScheduler.class);
    private final JdbcTemplate jdbc;
    private final OwnershipScheduleService service;
    public OwnershipScheduler(JdbcTemplate jdbc,OwnershipScheduleService service) { this.jdbc=jdbc;this.service=service; }

    @Scheduled(fixedDelayString="${app.ownership-scheduler.delay-ms:5000}",initialDelayString="${app.ownership-scheduler.initial-delay-ms:5000}")
    public void tick() { processDue(); }

    public void processDue() {
        var ids=jdbc.query("select id from service_order where status='SCHEDULED' and (effective_date<=billing_today() or not exists(select 1 from service_order_container sc where sc.service_order_id=service_order.id and sc.result_status in ('PLANNED','BLOCKED'))) order by effective_date,id",
            (rs,n)->rs.getObject(1,UUID.class));
        for(UUID id:ids) {
            try { service.execute(id); }
            catch(Exception error) { service.recordFailure(id,error instanceof ru.billing.app.error.ApiException ? error.getMessage() : "Не удалось выполнить передачу. Проверьте историю КТК и ожидаемую заявку"); log.warn("Ownership transfer {} remains scheduled: {}",id,error.getMessage()); }
        }
    }

    public void requireCurrent() {
        OwnershipScheduleGuard.requireCurrent(jdbc);
    }
}
