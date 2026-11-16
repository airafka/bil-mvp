package ru.billing.app.containerstock;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ContainerStorageCsvTest {
    @Test void escapesSpreadsheetFormulasQuotesAndMultilineValues() {
        var csv=new StringBuilder();
        ContainerStorageController.csv(csv,"=1\n+2","  +SUM(A1)","КТК \"тест\"",null,5);
        assertEquals("\"'=1\n+2\";\"'  +SUM(A1)\";\"КТК \"\"тест\"\"\";\"\";\"5\"\r\n",csv.toString());
    }
}
