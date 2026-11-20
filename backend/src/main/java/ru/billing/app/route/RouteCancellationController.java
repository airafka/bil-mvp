package ru.billing.app.route;
import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.order.OrderCancellationService;
import ru.billing.app.order.CreatedOrderResponse;
@RestController
@RequestMapping("/api/routes/{id}/cancellation")
public class RouteCancellationController {
    private final RouteCancellationService service;
    public RouteCancellationController(RouteCancellationService service){this.service=service;}
    @PostMapping public CreatedOrderResponse cancel(@PathVariable UUID id,@Valid @RequestBody OrderCancellationService.Request request){return service.cancel(id,request);}
}
