package ru.billing.app.containerstock;

import java.time.LocalDate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Refresh the stored snapshot before the first API request of a business day. */
@Service
public class ContainerOwnerRefreshService {
    private final JdbcTemplate jdbc;
    private volatile LocalDate refreshedDate;
    public ContainerOwnerRefreshService(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    @Transactional
    public void refresh() {
        LocalDate date=jdbc.queryForObject("select billing_today()",LocalDate.class);
        if(date.equals(refreshedDate)) return;
        jdbc.queryForObject("select refresh_container_owner_clients()",Integer.class);
        // Publish only after commit. Concurrent first requests may safely refresh again.
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { refreshedDate=date; }
        });
    }
}
