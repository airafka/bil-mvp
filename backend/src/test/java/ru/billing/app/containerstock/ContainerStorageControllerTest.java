package ru.billing.app.containerstock;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ContainerStorageControllerTest {
    @Test void exportIsAbsentUnderBothStoragePaths() throws Exception {
        var controller = new ContainerStorageController(mock(JdbcTemplate.class));
        var mvc = MockMvcBuilders.standaloneSetup(controller).build();
        mvc.perform(get("/api/container-periods/export")).andExpect(status().isNotFound());
        mvc.perform(get("/api/container-storage-periods/export")).andExpect(status().isNotFound());
    }

    @Test void preservesForwarderAndOrderPartyPositionsInTheReport() {
        assertEquals("Экспедитор / Организация", ContainerStorageController.partyPair("Экспедитор", "Организация"));
        assertEquals("Организация / Организация", ContainerStorageController.partyPair("Организация", "Организация"));
        assertEquals("Экспедитор / —", ContainerStorageController.partyPair("Экспедитор", null));
        assertEquals("— / Организация", ContainerStorageController.partyPair(null, "Организация"));
        assertNull(ContainerStorageController.partyPair(null, null));
    }
}
