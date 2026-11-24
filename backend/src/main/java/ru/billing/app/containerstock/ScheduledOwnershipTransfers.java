package ru.billing.app.containerstock;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class ScheduledOwnershipTransfers {
    private static final Logger log = LoggerFactory.getLogger(ScheduledOwnershipTransfers.class);
    static final ZoneId MOSCOW = ZoneId.of("Europe/Moscow");
    private static final LocalTime START = LocalTime.of(0, 1);

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public ScheduledOwnershipTransfers(JdbcTemplate jdbc, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.transactions = transactions;
    }

    @Scheduled(cron = "0 * * * * *", zone = "Europe/Moscow")
    public void applyDueTransfers() {
        var now = jdbc.queryForObject("select billing_now()", OffsetDateTime.class).atZoneSameInstant(MOSCOW);
        if (now.toLocalTime().isBefore(START)) return;

        var day = now.toLocalDate();
        var cutoff = day.plusDays(1).atStartOfDay(MOSCOW).toOffsetDateTime();
        var containers = jdbc.queryForList("""
                select distinct container_id from service_order_container
                where result_status='PLANNED' and plan_at < ? order by container_id
                """, UUID.class, cutoff);
        for (var id : containers) {
            try {
                transactions.executeWithoutResult(tx -> applyIfAvailable(id, day));
            } catch (DataAccessException | TransactionException ex) {
                log.error("Scheduled ownership transfer failed for container {}", id, ex);
            }
        }
    }

    private void applyIfAvailable(UUID id, LocalDate day) {
        // Acquire the shared calendar lock before claiming this container.
        if (!day.equals(jdbc.queryForObject("select billing_today()", LocalDate.class))) return;
        var locked = jdbc.queryForList("select id from container where id=? for update skip locked", UUID.class, id);
        if (!locked.isEmpty()) {
            jdbc.queryForObject("select refresh_container_owner_clients(array[?]::uuid[])", Integer.class, id);
        }
    }

    // Re-select already recorded owners when a historical working day rolls forward.
    @EventListener(ApplicationReadyEvent.class)
    @Scheduled(cron = "0 1 0 * * *", zone = "Europe/Moscow")
    public void refreshRecordedOwners() {
        jdbc.queryForObject("select refresh_owner_snapshot()", Integer.class);
    }
}
