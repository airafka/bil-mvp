package ru.billing.app.system;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import ru.billing.app.error.ApiException;

class OperationalResetServiceTest {
    @Test void disabledEndpointNeverTouchesDatabaseOrBackup() {
        var jdbc = mock(JdbcTemplate.class); var backup = mock(OperationalResetBackup.class);
        var service = new OperationalResetService(jdbc, backup, false);
        assertThatThrownBy(service::preview).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.reset(new OperationalResetService.ResetRequest("УДАЛИТЬ", "token"))).isInstanceOf(ApiException.class);
        verifyNoInteractions(jdbc, backup);
    }
    @Test void confirmationAndPreviewAreRequiredBeforeAnyDatabaseAction() {
        var jdbc = mock(JdbcTemplate.class); var backup = mock(OperationalResetBackup.class);
        var service = new OperationalResetService(jdbc, backup, true);
        for (String confirmation : new String[]{"", "удалить", " УДАЛИТЬ", "DELETE"}) {
            assertThatThrownBy(() -> service.reset(new OperationalResetService.ResetRequest(confirmation, "token"))).isInstanceOf(ApiException.class);
        }
        assertThatThrownBy(() -> service.reset(new OperationalResetService.ResetRequest("УДАЛИТЬ", null))).isInstanceOf(ApiException.class);
        verifyNoInteractions(jdbc, backup);
    }
}
