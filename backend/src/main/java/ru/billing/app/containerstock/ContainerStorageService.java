package ru.billing.app.containerstock;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Updates the visit and ownership inside the same locked stock/document transaction. */
@Service
public class ContainerStorageService {
    private final JdbcTemplate jdbc;
    public ContainerStorageService(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    @Transactional(propagation=Propagation.MANDATORY)
    public void onHistory(UUID history, UUID container, UUID order, String type, String newStatus) {
        jdbc.queryForObject("select apply_container_history(?)",Object.class,history);
    }
}
