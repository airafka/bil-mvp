package ru.billing.app.comprehensiveserviceorder;

import java.util.List;
import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/comprehensive-service-orders/{id}/no-return")
public class ServiceNoReturnController {
    private final ServiceNoReturnService service;
    public ServiceNoReturnController(ServiceNoReturnService service){this.service=service;}
    @GetMapping("/available-containers")
    public List<ServiceNoReturnService.Candidate> candidates(@PathVariable UUID id){return service.candidates(id);}
    @PostMapping
    public ComprehensiveServiceOrderDetails select(@PathVariable UUID id,@Valid @RequestBody ServiceNoReturnService.Request request){return service.select(id,request);}
}
