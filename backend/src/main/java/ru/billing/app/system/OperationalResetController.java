package ru.billing.app.system;

import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/system/operational-reset")
public class OperationalResetController {
    private final OperationalResetService service;
    public OperationalResetController(OperationalResetService service) { this.service = service; }
    @GetMapping("/availability") public Map<String, Boolean> availability() { return Map.of("enabled", service.enabled()); }
    @GetMapping public OperationalResetService.Preview preview() { return service.preview(); }
    @PostMapping public OperationalResetService.ResetResult reset(@RequestBody OperationalResetService.ResetRequest request) {
        return service.reset(request);
    }
}
