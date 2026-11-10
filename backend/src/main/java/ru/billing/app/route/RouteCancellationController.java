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
    private final OrderCancellationService orders;
    public RouteCancellationController(RouteCancellationService service,OrderCancellationService orders){this.service=service;this.orders=orders;}
    @PostMapping public CreatedOrderResponse cancel(@PathVariable UUID id,@Valid @RequestBody OrderCancellationService.Request request){return service.cancel(id,request);}
    @GetMapping public OrderCancellationService.Cancellation details(@PathVariable UUID id){return orders.details("routes",id);}
}
