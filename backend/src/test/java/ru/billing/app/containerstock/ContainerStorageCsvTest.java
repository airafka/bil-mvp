package ru.billing.app.containerstock;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ContainerStorageCsvTest {
    @Test void exportsTheStartOfAMoscowStorageDayInUtc() {
        var midnight = java.time.OffsetDateTime.parse("2026-11-30T00:00:00+03:00");
        assertEquals("29.11.2026 21:00 UTC", ContainerStorageController.format(midnight));
        assertEquals("", ContainerStorageController.format(null));
    }

    @Test void escapesSpreadsheetFormulasQuotesAndMultilineValues() {
        var csv=new StringBuilder();
        ContainerStorageController.csv(csv,"=1\n+2","  +SUM(A1)","КТК \"тест\"",null,5);
        assertEquals("\"'=1\n+2\";\"'  +SUM(A1)\";\"КТК \"\"тест\"\"\";\"\";\"5\"\r\n",csv.toString());
    }
}
