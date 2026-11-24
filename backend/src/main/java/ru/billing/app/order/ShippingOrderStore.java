package ru.billing.app.order;

import static ru.billing.app.order.OrderRowMapper.container;
import static ru.billing.app.order.OrderRowMapper.summary;
import static ru.billing.app.order.OrderRowMapper.terminalArea;
import static ru.billing.app.order.OrderRowMapper.transportType;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import ru.billing.app.error.ApiException;
import ru.billing.app.containerstock.ContainerLocks;

@Repository
public class ShippingOrderStore {

    private final JdbcTemplate jdbcTemplate;

    public ShippingOrderStore(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public CreatedOrderResponse create(CreateOrderRequest request) {
        // Assignment later in this transaction must not acquire a route after KTK locks.
        if (request.routeId()!=null) jdbcTemplate.query("select id from route where id=? for update",
                (rs,n)->rs.getObject(1,UUID.class),request.routeId());
        var ownerContainers = new ArrayList<UUID>();
        if(request.containers()!=null) request.containers().forEach(c -> ownerContainers.add(c.containerId()));
        if(request.railwayCarriages()!=null) request.railwayCarriages().forEach(w -> {
            if(w.containers()!=null) w.containers().forEach(c -> ownerContainers.add(c.containerId()));
        });
        ContainerLocks.lockCurrentOwners(jdbcTemplate, ownerContainers);
        UUID orderId = UUID.randomUUID();
        FillingType fillingType = request.fillingType() == null ? FillingType.ALL : request.fillingType();
        Integer code = jdbcTemplate.queryForObject(
                "insert into shipping_order "
                        + "(id, client_id, terminal_area_catalog_id, transport_type, contract_id, "
                        + "filling_type, order_status, planned_shipping_date_time, consignee_id) "
                        + "values (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?) returning number",
                Integer.class,
                orderId,
                request.clientId(),
                request.terminalAreaId(),
                request.transportType().name(),
                request.contractId(),
                fillingType.name(),
                request.departureAt(),
                ru.billing.app.reference.PartyReferences.clientParty(jdbcTemplate, request.consignee())
        );

        if (fillingType == FillingType.NONE_CONTAINER) {
            insertContainerQuantities(orderId, request.containerQuantities());
        } else if (request.transportType() == TransportType.VEHICLE) {
            request.containers().forEach(container -> insertContainer(orderId, null, container));
        } else {
            insertNumberedCarriages(orderId, request);
        }

        jdbcTemplate.update("update shipping_order set authorized_representative=?, phone=?, email=?, comment=?, transport_waybill_number=? where id=?",
                request.authorizedRepresentative(), request.phone(), request.email(), request.comment(), request.transportWaybillNumber(), orderId);
        return new CreatedOrderResponse(orderId, code, "DRAFT");
    }

    public PagedResponse<OrderSummary> findPage(int requestedPage, int requestedSize, String query, String status) {
        int page = Math.max(0, requestedPage);
        int size = Math.max(1, Math.min(requestedSize, 100));
        long total = jdbcTemplate.queryForObject("select count(*) from shipping_order o join client c on c.id = o.client_id left join contract ct on ct.id = o.contract_id where (? = '' or position(lower(?) in lower(concat_ws(' ', o.number::text, c.name, ct.name))) > 0) and (? = '' or o.order_status = ?)", Long.class, query, query, status, status);
        List<OrderSummary> items = jdbcTemplate.query(
                """
                select o.id, o.number as code, o.client_id, c.name as client_name,
                       o.planned_shipping_date_time as planned_at,
                       r.number as route_number, o.comment,
                       a.id as area_id, a.code as area_code, a.name as area_name,
                       o.transport_type, o.filling_type, o.order_status as status, o.contract_id, ct.name as contract_name, o.route_id
                from shipping_order o
                join client c on c.id = o.client_id
                left join contract ct on ct.id = o.contract_id
                left join route r on r.id = o.route_id
                join terminal_area_catalog a on a.id = o.terminal_area_catalog_id
                 where (? = '' or position(lower(?) in lower(concat_ws(' ', o.number::text, c.name, ct.name))) > 0) and (? = '' or o.order_status = ?)
                order by o.number desc
                limit ? offset ?
                """,
                (resultSet, rowNumber) -> summary(resultSet, fillingType(resultSet.getString("filling_type"))),
                query, query, status, status, size,
                page * size
        );
        return PagedResponse.of(items, page, size, total);
    }

    public OrderDetails findById(UUID id) {
        List<OrderHeader> headers = jdbcTemplate.query(
                """
                select o.id, o.number as code, o.client_id, c.name as client_name,
                       a.id as area_id, a.code as area_code, a.name as area_name,
                       o.transport_type, o.filling_type, o.order_status as status, o.contract_id, ct.name as contract_name, o.route_id,
                       o.planned_shipping_date_time as departure_at, (select name from client_related_entity where id=o.consignee_id) as consignee,
                       o.authorized_representative, o.phone, o.email, o.comment, ct.contract_type, o.created_at, o.transport_waybill_number
                from shipping_order o
                join client c on c.id = o.client_id
                left join contract ct on ct.id = o.contract_id
                join terminal_area_catalog a on a.id = o.terminal_area_catalog_id
                where o.id = ?
                """,
                (resultSet, rowNumber) -> new OrderHeader(
                        resultSet.getObject("id", UUID.class),
                        resultSet.getInt("code"),
                        resultSet.getObject("client_id", UUID.class),
                        resultSet.getString("client_name"),
                        terminalArea(resultSet),
                        transportType(resultSet.getString("transport_type")),
                        fillingType(resultSet.getString("filling_type")),
                        resultSet.getString("status"),
                        resultSet.getObject("contract_id", UUID.class),
                        resultSet.getString("contract_name"),
                        resultSet.getObject("route_id", UUID.class),
                        resultSet.getObject("departure_at", LocalDateTime.class),
                        resultSet.getString("consignee"), resultSet.getString("authorized_representative"), resultSet.getString("phone"), resultSet.getString("email"), resultSet.getString("comment"), resultSet.getString("contract_type"), resultSet.getObject("created_at", java.time.OffsetDateTime.class), resultSet.getString("transport_waybill_number")
                ),
                id
        );
        if (headers.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "ORDER_NOT_FOUND", "Заявка не найдена");
        }

        OrderHeader header = headers.getFirst();
        List<OrderContainerDetails> containers = header.transportType()==TransportType.VEHICLE ? loadContainers(id) : List.of();
        List<ShippingOrderRailwayCarriageDetails> railwayCarriages = header.transportType()==TransportType.RAILWAY ? loadRailwayCarriages(id) : List.of();
        List<ContainerQuantityDetails> containerQuantities=loadContainerQuantities(id);

        return new OrderDetails(
                header.id(), header.code(), header.clientId(), header.clientName(),
                header.terminalArea(), header.transportType(),
                header.fillingType(), header.status(),
                containers, List.of(), railwayCarriages, containerQuantities,
                header.contractId(), header.contractName(), header.routeId(),
                null, null, header.departureAt(), header.consignee(), null, null, header.authorizedRepresentative(), header.phone(), header.email(), header.comment(), header.contractType(), header.createdAt(), header.transportWaybillNumber()
        );
    }

    public void updateContainerAttributes(UUID id, UpdateOrderContainersRequest request) {
        var headers = jdbcTemplate.query("select order_status as status, transport_type from shipping_order where id = ? for update",
                (rs, row) -> List.of(rs.getString("status"), rs.getString("transport_type")), id);
        if (headers.isEmpty()) throw new ApiException(HttpStatus.NOT_FOUND, "ORDER_NOT_FOUND", "Заявка не найдена");
        if (!"DRAFT".equals(headers.getFirst().getFirst())) {
            throw new ApiException(HttpStatus.CONFLICT, "CONTAINER_ATTRIBUTES_NOT_EDITABLE", "Реквизиты КТК можно менять только в черновике вывоза");
        }
        // Lock the whole PATCH, including additions, before updating any existing row.
        // A later additions-only lock would invert batches with opposite input orders.
        var ownerContainers = new ArrayList<UUID>();
        request.containers().forEach(c -> ownerContainers.add(c.containerId()));
        request.additions().forEach(a -> ownerContainers.add(a.container().containerId()));
        ContainerLocks.lockCurrentOwners(jdbcTemplate, ownerContainers);
        if(request.metadata()!=null) {
            jdbcTemplate.update("update shipping_order set planned_shipping_date_time=?, consignee_id=? where id=?", request.metadata().plannedAt(), ru.billing.app.reference.PartyReferences.clientParty(jdbcTemplate, request.metadata().consignee()), id);
        }
        var seen = new java.util.HashSet<UUID>();
        for (var c : request.containers()) {
            if (!seen.add(c.containerId())) throw new ApiException(HttpStatus.BAD_REQUEST, "DUPLICATE_CONTAINER", "КТК указан дважды");
            int count = jdbcTemplate.update("update shipping_order_container set owner_container_id = ?, seal_numbers = ?, seal_type_id = ?, danger_class_id = ? where shipping_order_id = ? and container_id = ?",
                    registryOwner(c.containerId()), c.sealNumbers(), c.sealTypeId(), c.hazardClassId(), id, c.containerId());
            if (count != 1) throw new ApiException(HttpStatus.NOT_FOUND, "ORDER_CONTAINER_NOT_FOUND", "КТК отсутствует в этой заявке");
        }
    }

    private void insertNumberedCarriages(UUID orderId, CreateOrderRequest request) {
        for (ShippingOrderRailwayCarriageRequest carriage : request.railwayCarriages()) {
            UUID carriageRowId = UUID.randomUUID();
            jdbcTemplate.update(
                    "insert into shipping_order_railway_carriage (id, shipping_order_id, railway_carriage_id) "
                            + "values (?, ?, ?)",
                    carriageRowId,
                    orderId,
                    carriage.railwayCarriageId()
            );
            carriage.containers().forEach(container -> insertContainer(orderId, carriageRowId, container));
        }
    }

    private void insertContainerQuantities(UUID orderId, List<ContainerQuantityRequest> rows) {
        for (ContainerQuantityRequest row : rows) {
            UUID rowId = UUID.randomUUID();
            jdbcTemplate.update(
                    "insert into shipping_order_container_qty (id, shipping_order_id, quantity, type, empty, owner_client_id) "
                            + "values (?, ?, ?, ?, ?, ?)",
                    rowId, orderId, row.quantity(), row.type().name(), row.empty(), row.ownerClientId()
            );
        }
    }

    private UUID registryOwner(UUID containerId) {
        return jdbcTemplate.queryForObject("select (select client_id from container_owner_current where container_id=?)", UUID.class, containerId);
    }
    UUID insertContainer(UUID orderId, UUID carriageRowId, OrderContainerRequest container) {
        UUID orderContainerId = UUID.randomUUID();
        jdbcTemplate.update(
                "insert into shipping_order_container "
                        + "(id, shipping_order_id, shipping_order_railway_carriage_id, container_id, empty, owner_container_id, seal_numbers, seal_type_id, danger_class_id) "
                        + "values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                orderContainerId,
                orderId,
                carriageRowId,
                container.containerId(),
                container.empty(), registryOwner(container.containerId()), container.sealNumbers(), container.sealTypeId(), container.hazardClassId()
        );
        for (var cargo : container.cargoItems()) insertCargo(orderContainerId, cargo);
        return orderContainerId;
    }

    private void insertCargo(UUID orderContainerId, CargoRequest cargo) {
        if (cargo == null) return;
        jdbcTemplate.update(
                "insert into shipping_order_container_item "
                        + "(id, shipping_order_container_id, etsng_code_id, wight_net) values (?, ?, ?, ?)",
                UUID.randomUUID(), orderContainerId, cargo.etsngCodeId(), cargo.weight()
        );
    }

    private List<OrderContainerDetails> loadContainers(UUID orderId) {
        return OrderContainerDetails.merge(jdbcTemplate.query(
                """
                select oc.id as task_id, c.container_type, oc.container_id, c.code as container_name, oc.empty,
                       case when so.order_status = 'DRAFT' then stock.client_id else oc.owner_container_id end as owner_container_id, owner.name as owner_container_name, oc.seal_numbers,
                       oc.seal_type_id, st.code as seal_type_name, oc.danger_class_id, hc.code as danger_class_name,
                       item.etsng_code_id, e.code as etsng_code_name, item.wight_net, coalesce(stock.status,'DEPARTED') as container_status
                  from shipping_order_container oc
                  join container c on c.id = oc.container_id
                  left join shipping_order so on so.id = oc.shipping_order_id
                  left join container_owner_current stock on stock.container_id = oc.container_id
                  left join client owner on owner.id = case when so.order_status = 'DRAFT' then stock.client_id else oc.owner_container_id end
                  left join seal_type st on st.id = oc.seal_type_id
                  left join danger_class hc on hc.id = oc.danger_class_id
                  left join shipping_order_container_item item on item.shipping_order_container_id = oc.id
                  left join etsng_code e on e.id = item.etsng_code_id
                 where oc.shipping_order_id = ? and oc.shipping_order_railway_carriage_id is null
                 order by c.code
                """,
                (resultSet, rowNumber) -> container(resultSet),
                orderId
        ));
    }

    private List<ShippingOrderRailwayCarriageDetails> loadRailwayCarriages(UUID orderId) {
        List<RailwayContainerRow> rows = jdbcTemplate.query(
                """
                select sorc.id as carriage_row_id, sorc.railway_carriage_id,
                       rc.code as railway_carriage_code, wagon_owner.name as wagon_owner_name,
                       oc.id as task_id, c.container_type, oc.container_id, c.code as container_name, oc.empty,
                       case when so.order_status = 'DRAFT' then stock.client_id else oc.owner_container_id end as owner_container_id, owner.name as owner_container_name, oc.seal_numbers,
                       oc.seal_type_id, st.code as seal_type_name, oc.danger_class_id, hc.code as danger_class_name,
                       item.etsng_code_id, e.code as etsng_code_name, item.wight_net, coalesce(stock.status,'DEPARTED') as container_status
                  from shipping_order_railway_carriage sorc
                  join railway_carriage rc on rc.id = sorc.railway_carriage_id
                  left join railway_carriage_owner current_wagon on current_wagon.railway_carriage_id=rc.id
                  left join client wagon_owner on wagon_owner.id=coalesce(sorc.owner_railway_carriage_id,current_wagon.client_owner_id)
                  left join shipping_order_container oc
                    on oc.shipping_order_railway_carriage_id = sorc.id
                   and oc.shipping_order_id = sorc.shipping_order_id
                  left join container c on c.id = oc.container_id
                  join shipping_order so on so.id = sorc.shipping_order_id
                  left join container_owner_current stock on stock.container_id = oc.container_id
                  left join client owner on owner.id = case when so.order_status = 'DRAFT' then stock.client_id else oc.owner_container_id end
                  left join seal_type st on st.id = oc.seal_type_id
                  left join danger_class hc on hc.id = oc.danger_class_id
                  left join shipping_order_container_item item on item.shipping_order_container_id = oc.id
                  left join etsng_code e on e.id = item.etsng_code_id
                 where sorc.shipping_order_id = ?
                 order by rc.code, sorc.id, c.code
                """,
                (resultSet, rowNumber) -> new RailwayContainerRow(
                        resultSet.getObject("carriage_row_id", UUID.class),
                        resultSet.getObject("railway_carriage_id", UUID.class),
                        resultSet.getString("railway_carriage_code"),resultSet.getString("wagon_owner_name"),
                        resultSet.getObject("container_id", UUID.class) == null ? null : container(resultSet)
                ),
                orderId
        );
        Map<UUID, RailwayCarriageBuilder> grouped = new LinkedHashMap<>();
        rows.forEach(row -> {
            RailwayCarriageBuilder builder = grouped.computeIfAbsent(
                    row.carriageRowId(),
                    ignored -> new RailwayCarriageBuilder(
                            row.railwayCarriageId(), row.railwayCarriageCode(), row.ownerName(), new ArrayList<>()
                    )
            );
            if (row.container() != null) builder.containers().add(row.container());
        });
        return grouped.values().stream().map(builder -> new ShippingOrderRailwayCarriageDetails(
                builder.railwayCarriageId(), builder.railwayCarriageCode(), builder.ownerName(), OrderContainerDetails.merge(builder.containers())
        )).toList();
    }

    private List<ContainerQuantityDetails> loadContainerQuantities(UUID orderId) {
        return jdbcTemplate.query(
                """
                select q.id, q.quantity, q.type, q.empty, q.owner_client_id, owner.name as owner_name
                  from shipping_order_container_qty q left join client owner on owner.id=q.owner_client_id
                 where shipping_order_id = ?
                 order by q.type, q.empty desc, q.id
                """,
                (resultSet, rowNumber) -> new ContainerQuantityDetails(
                        resultSet.getObject("id", UUID.class),
                        resultSet.getInt("quantity"),
                        ContainerType.valueOf(resultSet.getString("type")),
                        resultSet.getBoolean("empty"), resultSet.getObject("owner_client_id",UUID.class), resultSet.getString("owner_name")
                ),
                orderId
        );
    }

    private FillingType fillingType(String value) {
        return value == null ? FillingType.ALL : FillingType.valueOf(value);
    }

    private record OrderHeader(
            UUID id,
            int code,
            UUID clientId,
            String clientName,
            TerminalAreaDetails terminalArea,
            TransportType transportType,
            FillingType fillingType,
            String status,
            UUID contractId,
            String contractName,
            UUID routeId,
            LocalDateTime departureAt,
            String consignee, String authorizedRepresentative, String phone, String email, String comment, String contractType, java.time.OffsetDateTime createdAt, String transportWaybillNumber
    ) {
    }

    private record RailwayContainerRow(
            UUID carriageRowId,
            UUID railwayCarriageId,
            String railwayCarriageCode, String ownerName,
            OrderContainerDetails container
    ) {
    }

    private record RailwayCarriageBuilder(
            UUID railwayCarriageId,
            String railwayCarriageCode, String ownerName,
            List<OrderContainerDetails> containers
    ) {
    }


}
