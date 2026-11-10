package ru.billing.app.order;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.billing.app.reference.ReferenceDataService;
import ru.billing.app.route.RouteService;

@Service
public class ReceivingOrderService {

    private final OrderRequestValidator validator;
    private final ReferenceDataService referenceDataService;
    private final ReceivingOrderStore store;
    private final RouteService routeService;
    private final OrderContainerAdditionService additions;

    public ReceivingOrderService(
            OrderRequestValidator validator,
            ReferenceDataService referenceDataService,
            ReceivingOrderStore store,
            RouteService routeService, OrderContainerAdditionService additions
    ) {
        this.validator = validator;
        this.referenceDataService = referenceDataService;
        this.store = store;
        this.routeService = routeService;
        this.additions = additions;
    }

    @Transactional
    public CreatedOrderResponse create(CreateOrderRequest request) {
        validator.validate(request);
        if (!request.containerOwners().isEmpty() && request.transportType() != TransportType.RAILWAY) {
            throw new ru.billing.app.error.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "CONTAINER_OWNERS_RAILWAY_ONLY", "Индивидуальные собственники накладных задаются только в ЖД-поставке");
        }
        if (request.containerOwners().stream().map(CreateOrderRequest.ContainerOwner::containerId).distinct().count() != request.containerOwners().size()) {
            throw new ru.billing.app.error.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "DUPLICATE_CONTAINER", "КТК указан дважды");
        }
        if (request.defaultContainerOwnerId() == null) {
            throw new ru.billing.app.error.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "DEFAULT_CONTAINER_OWNER_REQUIRED", "Выберите собственника КТК по умолчанию в заявке на поставку");
        }
        referenceDataService.validateContainerAttributes(request.effectiveDefaultContainerOwnerId(),null,null);
        if (request.transportType() == TransportType.RAILWAY) {
            referenceDataService.validateCommonReferences(request);
            request.containerOwners().forEach(c -> referenceDataService.validateContainerAttributes(c.ownerClientId(), null, null));
            CreatedOrderResponse created = store.createRailway(request);
            if (!request.containerOwners().isEmpty()) store.updateContainerAttributes(created.id(), new UpdateOrderContainersRequest(
                request.containerOwners().stream().map(c -> new UpdateOrderContainersRequest.Attributes(c.containerId(), c.ownerClientId(), null, null, null)).toList()));
            if (request.routeId() != null) routeService.assign(request.routeId(), java.util.List.of(created.id()));
            return created;
        }
        referenceDataService.validateReferences(request);
        request.containers().forEach(c -> referenceDataService.validateContainerAttributes(c.ownerClientId(), c.sealTypeId(), c.hazardClassId()));
        CreatedOrderResponse created = store.createVehicle(request);
        if (request.routeId() != null) routeService.assign(request.routeId(), java.util.List.of(created.id()));
        return created;
    }

    @Transactional
    public OrderDetails updateContainerAttributes(UUID id, UpdateOrderContainersRequest request) {
        if(request.defaultContainerOwnerId()!=null) referenceDataService.validateContainerAttributes(request.defaultContainerOwnerId(),null,null);
        request.containers().forEach(c -> referenceDataService.validateContainerAttributes(c.ownerClientId(), c.sealTypeId(), c.hazardClassId()));
        store.updateContainerAttributes(id, request);
        additions.add(true, id, request.additions());
        return store.findById(id);
    }

    @Transactional(readOnly = true)
    public PagedResponse<OrderSummary> findPage(int page, int size) {
        return findPage(page, size, "", "");
    }

    @Transactional(readOnly = true)
    public PagedResponse<OrderSummary> findPage(int page, int size, String query, String status) {
        return store.findPage(page, size, query, status);
    }

    @Transactional(readOnly = true)
    public OrderDetails findById(UUID id) {
        return store.findById(id);
    }
}
