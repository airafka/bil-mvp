package ru.billing.app.order;

import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/{resource:receiving-orders|shipping-orders}/{id}/cancellation")
public class OrderCancellationController {
    private final OrderCancellationService service;
    public OrderCancellationController(OrderCancellationService service){this.service=service;}
    @PostMapping
    public CreatedOrderResponse cancel(@PathVariable String resource,@PathVariable UUID id,@Valid @RequestBody OrderCancellationService.Request request) {
        return service.cancel(resource,id,request);
    }
    @GetMapping
    public OrderCancellationService.Cancellation details(@PathVariable String resource,@PathVariable UUID id){return service.details(resource,id);}
}
