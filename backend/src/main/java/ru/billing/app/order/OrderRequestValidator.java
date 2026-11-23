package ru.billing.app.order;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import ru.billing.app.error.ApiException;

@Component
public class OrderRequestValidator {

    public void validate(CreateOrderRequest request) {
        validateCommon(request);
        if (request.transportType() == TransportType.RAILWAY) {
            validateReceivingRailway(request);
        } else {
            validateVehicle(request);
        }
    }

    public void validateShipping(CreateOrderRequest request) {
        validateCommon(request);
        if (request.transportType() == TransportType.VEHICLE) {
            if (effectiveFillingType(request) == FillingType.NONE_CONTAINER) {
                validateUnnumberedVehicleShipping(request);
            } else {
                validateVehicle(request);
            }
            return;
        }
        if (hasValues(request.waybillIds())) {
            throw badRequest(
                    "WAYBILLS_NOT_ALLOWED_FOR_RAILWAY_SHIPPING",
                    "Железнодорожный вывоз создаётся без накладных"
            );
        }

        if (effectiveFillingType(request) != FillingType.ALL) {
            throw badRequest("NONE_CONTAINER_ONLY_FOR_VEHICLE_SHIPPING", "Для ЖД-вывоза укажите номера вагонов и КТК");
        }
        validateAll(request);
    }

    public FillingType effectiveFillingType(CreateOrderRequest request) {
        return request.fillingType() == null ? FillingType.ALL : request.fillingType();
    }

    private void validateCommon(CreateOrderRequest request) {
        if (request.contractId() == null) throw badRequest("CONTRACT_REQUIRED", "Выберите договор");
        if (request.terminalAreaId() == null) {
            throw badRequest("TERMINAL_AREA_REQUIRED", "Площадка обязательна");
        }
        if (request.transportType() == null) {
            throw badRequest("TRANSPORT_TYPE_REQUIRED", "Тип транспорта обязателен");
        }
    }

    private void validateVehicle(CreateOrderRequest request) {
        if (effectiveFillingType(request) != FillingType.ALL) {
            throw badRequest(
                    "INVALID_VEHICLE_FILLING_TYPE",
                    "Для номерного автовывоза должен использоваться тип заполнения ALL"
            );
        }
        if (hasValues(request.waybillIds())) {
            throw badRequest("WAYBILLS_NOT_ALLOWED_FOR_VEHICLE", "Для автомобильной заявки накладные не выбираются");
        }
        if (hasValues(request.railwayCarriages())) {
            throw badRequest("RAILWAY_CARRIAGES_NOT_ALLOWED_FOR_VEHICLE", "Для автотранспорта вагоны не указываются");
        }
        rejectContainerQuantities(request);
        if (!hasValues(request.containers())) {
            throw badRequest("EMPTY_CONTAINER_LIST", "Выберите хотя бы один КТК");
        }
        validateContainers(request.containers(), new HashSet<>(), false);
    }

    private void validateUnnumberedVehicleShipping(CreateOrderRequest request) {
        if (hasValues(request.waybillIds())) {
            throw badRequest("WAYBILLS_NOT_ALLOWED_FOR_VEHICLE", "Для автомобильной заявки накладные не выбираются");
        }
        if (hasValues(request.railwayCarriages())) {
            throw badRequest("RAILWAY_CARRIAGES_NOT_ALLOWED_FOR_VEHICLE", "Для автотранспорта вагоны не указываются");
        }
        if (hasValues(request.containers())) {
            throw badRequest(
                    "NUMBERED_CONTAINERS_NOT_ALLOWED",
                    "Для безномерного автовывоза конкретный номер КТК не указывается"
            );
        }
        if (request.containerQuantities() == null || request.containerQuantities().size() != 1) {
            throw badRequest(
                    "SINGLE_CONTAINER_QUANTITY_REQUIRED",
                    "Для безномерного автовывоза должна быть указана одна строка КТК"
            );
        }

        ContainerQuantityRequest row = request.containerQuantities().getFirst();
        if (row == null) {
            throw badRequest("CONTAINER_QUANTITY_REQUIRED", "Данные КТК обязательны");
        }
        if (row.quantity() == null || row.quantity() != 1) {
            throw badRequest(
                    "INVALID_QUANTITY",
                    "В безномерном автовывозе допустим один КТК"
            );
        }
        if (row.type() == null) {
            throw badRequest("CONTAINER_TYPE_REQUIRED", "Типоразмер КТК обязателен");
        }
        if (!Boolean.TRUE.equals(row.empty())) {
            throw badRequest(
                    "NONE_CONTAINER_CONTAINER_MUST_BE_EMPTY",
                    "Для безномерного автовывоза разрешён только порожний КТК"
            );
        }
        if (hasValues(row.items())) {
            throw badRequest(
                    "CARGO_NOT_ALLOWED_FOR_NONE_CONTAINER",
                    "Для безномерного автовывоза сведения о грузе не передаются"
            );
        }
    }

    private void validateReceivingRailway(CreateOrderRequest request) {
        if (effectiveFillingType(request) != FillingType.ALL) {
            throw badRequest("INVALID_FILLING_TYPE", "Тип заполнения поддерживается только для заявок на вывоз");
        }
        rejectContainerQuantities(request);
        if (hasValues(request.containers())) {
            throw badRequest("CONTAINERS_NOT_ALLOWED_FOR_RAILWAY", "Железнодорожная заявка создаётся по накладным");
        }
        if (!hasValues(request.waybillIds())) {
            throw badRequest("EMPTY_WAYBILL_LIST", "Выберите хотя бы одну накладную");
        }
        if (hasValues(request.railwayCarriages())) {
            throw badRequest(
                    "RAILWAY_CARRIAGES_NOT_ALLOWED_FOR_RECEIVING",
                    "Железнодорожная заявка на поставку создаётся по накладным"
            );
        }
        Set<UUID> uniqueWaybillIds = new HashSet<>();
        for (UUID waybillId : request.waybillIds()) {
            if (!uniqueWaybillIds.add(waybillId)) {
                throw badRequest("DUPLICATE_WAYBILL", "Одна накладная не может быть выбрана дважды");
            }
        }
    }

    private void validateAll(CreateOrderRequest request) {
        rejectContainerQuantities(request);
        if (hasValues(request.containers())) {
            throw badRequest("CONTAINERS_NOT_ALLOWED_FOR_RAILWAY", "Для ЖД распределите КТК по вагонам");
        }
        validateNumberedCarriages(request);
    }

    private void validateNumberedCarriages(CreateOrderRequest request) {
        if (!hasValues(request.railwayCarriages())) {
            throw badRequest("RAILWAY_CARRIAGES_REQUIRED", "Добавьте хотя бы один вагон");
        }
        Set<UUID> carriageIds = new HashSet<>();
        Set<UUID> containerIds = new HashSet<>();
        for (ShippingOrderRailwayCarriageRequest carriage : request.railwayCarriages()) {
            if (carriage == null || carriage.railwayCarriageId() == null) {
                throw badRequest("RAILWAY_CARRIAGE_REQUIRED", "Выберите вагон");
            }
            if (!carriageIds.add(carriage.railwayCarriageId())) {
                throw badRequest("DUPLICATE_RAILWAY_CARRIAGE", "Один вагон нельзя добавить в заявку дважды");
            }
            if (!hasValues(carriage.containers())) {
                throw badRequest("EMPTY_RAILWAY_CARRIAGE", "Добавьте хотя бы один КТК на вагон");
            }
            validateContainers(carriage.containers(), containerIds, true);
        }
    }

    private void validateContainers(
            Iterable<OrderContainerRequest> containers,
            Set<UUID> containerIds,
            boolean railway
    ) {
        for (OrderContainerRequest container : containers) {
            if (!containerIds.add(container.containerId())) {
                throw badRequest(
                        "DUPLICATE_CONTAINER",
                        railway ? "Один КТК нельзя добавить в ЖД-заявку дважды" : "Один КТК нельзя добавить в заявку дважды"
                );
            }
            validateCargo(container.empty(), container.cargoItems());
        }
    }

    private void validateCargo(Boolean empty, List<CargoRequest> items) {
        if (Boolean.TRUE.equals(empty) && !items.isEmpty()) {
            throw badRequest("CARGO_FOR_EMPTY_CONTAINER", "Для порожнего КТК нельзя указывать груз");
        }
        if (Boolean.FALSE.equals(empty) && items.isEmpty()) {
            throw badRequest("CARGO_REQUIRED", "Для гружёного КТК укажите груз и массу");
        }
        for (CargoRequest item : items) {
            if (item.weight() == null || item.weight().signum() <= 0) {
                throw badRequest("INVALID_WEIGHT", "Масса должна быть больше нуля");
            }
        }
    }

    private void rejectContainerQuantities(CreateOrderRequest request) {
        if (hasValues(request.containerQuantities())) {
            throw badRequest("CONTAINER_QUANTITIES_NOT_ALLOWED", "Количественные КТК не разрешены");
        }
    }

    private boolean hasValues(List<?> values) {
        return values != null && !values.isEmpty();
    }

    private ApiException badRequest(String code, String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, code, message);
    }
}
