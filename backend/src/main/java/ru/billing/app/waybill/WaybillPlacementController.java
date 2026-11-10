package ru.billing.app.waybill;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.order.PagedResponse;
import java.util.List;
@RestController
@RequestMapping("/api/waybills/placement")
public class WaybillPlacementController {
    private final WaybillPlacementService service;
    public WaybillPlacementController(WaybillPlacementService service){this.service=service;}
    @GetMapping("/candidates") public PagedResponse<WaybillPlacementService.Candidate> candidates(@RequestParam(defaultValue="") String query,@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="20") int size){return service.candidates(query.trim(),page,size);}
    @GetMapping("/wagons") public List<WaybillPlacementService.Wagon> wagons(@RequestParam(defaultValue="") String query){return service.wagons(query.trim());}
    @PostMapping("/preview") public WaybillPlacementService.Layout preview(@Valid @RequestBody WaybillPlacementService.Selection request){return service.preview(request);}
    @PutMapping public WaybillPlacementService.Layout save(@Valid @RequestBody WaybillPlacementService.Save request){return service.save(request);}
}
