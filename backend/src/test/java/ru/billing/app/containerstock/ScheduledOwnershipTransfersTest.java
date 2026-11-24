package ru.billing.app.containerstock;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class ScheduledOwnershipTransfersTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private final ScheduledOwnershipTransfers worker = new ScheduledOwnershipTransfers(jdbc, transactions);

    @Test
    void waitsUntilOneMinutePastMoscowMidnight() {
        when(jdbc.queryForObject("select billing_now()", OffsetDateTime.class))
                .thenReturn(OffsetDateTime.parse("2026-11-29T21:00:59.999999Z"));

        worker.applyDueTransfers();

        verify(jdbc).queryForObject("select billing_now()", OffsetDateTime.class);
        verifyNoMoreInteractions(jdbc);
        verifyNoInteractions(transactions);
    }

    @Test
    void selectsTheMoscowWorkingDayAtTheFirstEligibleTick() {
        when(jdbc.queryForObject("select billing_now()", OffsetDateTime.class))
                .thenReturn(OffsetDateTime.parse("2026-11-29T21:01:00Z"));
        var nextMidnight = OffsetDateTime.parse("2026-12-01T00:00:00+03:00");
        when(jdbc.queryForList(contains("result_status='PLANNED'"), eq(UUID.class), eq(nextMidnight)))
                .thenReturn(List.of(UUID.randomUUID()));

        worker.applyDueTransfers();

        verify(transactions).executeWithoutResult(any());
    }
}
