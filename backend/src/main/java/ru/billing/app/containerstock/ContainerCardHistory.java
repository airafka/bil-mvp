package ru.billing.app.containerstock;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import ru.billing.app.error.ApiException;
import ru.billing.app.order.PagedResponse;
import ru.billing.app.reference.ContainerReferenceOption;
import ru.billing.app.reference.ReferenceDataService;

@Service
public class ContainerCardHistory {
    private final JdbcClient jdbc;
    private final ReferenceDataService references;

    public ContainerCardHistory(JdbcClient jdbc, ReferenceDataService references) {
        this.jdbc = jdbc;
        this.references = references;
    }

    public record Filter(Long orderNumber, String orderType, UUID oldClientId, UUID newClientId,
                         LocalDate createdFrom, LocalDate createdTo) {}
    public record Entry(UUID id, OffsetDateTime createdAt, OffsetDateTime occurredAt, UUID orderId, Long orderNumber,
                        String orderType, UUID oldClientId, UUID newClientId, String oldClientName, String newClientName, String oldStatus, String newStatus) {
        @JsonProperty("newClient")
        public EntityReference newClient() { return EntityReference.named(newClientId, newClientName); }

        @JsonProperty("oldClient")
        public EntityReference oldClient() { return EntityReference.named(oldClientId, oldClientName); }
    }
    public record Option(String value, String label) {}
    public record Options(List<Option> orderNumber, List<Option> orderType, List<Option> oldClientId, List<Option> newClientId) {}
    public record Card(ContainerReferenceOption container, PagedResponse<Entry> history, Options options) {}

    // The card follows dev_back's getPage predicate. Stock history has its own rules for reservations and cancellations.
    private static final String EVENTS = """
            with events as (
                select h.id, h.created_at at time zone 'UTC' as created_at, h.occurred_at,
                       h.order_id, h.order_type, coalesce(r.number, s.number, so.number) as order_number,
                       h.timeline_old_client_id as old_client_id, old.name as old_client_name,
                       h.new_client_id, new.name as new_client_name, h.old_status, h.new_status
                from container_owner_history_timeline h
                left join receiving_order r on h.order_type='RECEIVING_ORDER' and r.id=h.order_id
                left join shipping_order s on h.order_type='SHIPPING_ORDER' and s.id=h.order_id
                left join service_order so on h.order_type='SERVICE_ORDER' and so.id=h.order_id
                left join client old on old.id=h.timeline_old_client_id
                left join client new on new.id=h.new_client_id
                where h.container_id=:id and ((h.order_type='SERVICE_ORDER' and so.status<>'CANCELLED' and (h.occurred_at at time zone 'Europe/Moscow')::date<=billing_today()) or
                    (coalesce(r.order_status,s.order_status)='DONE' and h.new_status in ('ON_TERMINAL','DEPARTED')))
            )
            """;

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Card get(UUID id, Filter filter, int page, int size) {
        if (page < 0 || size < 1 || size > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_PAGE", "Недопустимый номер или размер страницы");
        }
        if (filter.createdFrom != null && filter.createdTo != null && filter.createdFrom.isAfter(filter.createdTo)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_DATE_RANGE", "Дата окончания раньше даты начала");
        }
        var container = references.getContainer(id);
        var query = new HistoryQuery(id, filter);
        long count = query.select("count(*)", null, "").query(Long.class).single();
        int lastPage = count == 0 ? 0 : (int) ((count - 1) / size);
        int current = Math.min(page, lastPage);
        var rows = query.select("*", null, " order by created_at desc, id desc limit :size offset :offset")
                .param("size", size).param("offset", (long) current * size).query(Entry.class).list();
        var options = new Options(query.options("order_number", "order_number"), query.options("order_type", "order_type"),
                query.options("old_client_id", "old_client_name"), query.options("new_client_id", "new_client_name"));
        return new Card(container, PagedResponse.of(rows, current, size, count), options);
    }

    private class HistoryQuery {
        final UUID id;
        final Filter filter;

        HistoryQuery(UUID id, Filter filter) {
            this.id = id;
            this.filter = filter;
        }

        // Each list offers values compatible with the other controls, including matches on later pages.
        List<Option> options(String field, String label) {
            return select("distinct " + field + " as value, " + label + " as label", field,
                    " and " + field + " is not null order by label, value").query(Option.class).list();
        }

        JdbcClient.StatementSpec select(String projection, String ignored, String tail) {
            var sql = new StringBuilder(EVENTS).append("select ").append(projection).append(" from events where true");
            var params = new java.util.HashMap<String, Object>();
            params.put("id", id);
            addFilter(sql, params, "order_number", filter.orderNumber, ignored);
            addFilter(sql, params, "order_type", filter.orderType, ignored);
            addFilter(sql, params, "old_client_id", filter.oldClientId, ignored);
            addFilter(sql, params, "new_client_id", filter.newClientId, ignored);
            if (filter.createdFrom != null) {
                sql.append(" and (created_at at time zone 'UTC')::date >= :createdFrom");
                params.put("createdFrom", filter.createdFrom);
            }
            if (filter.createdTo != null) {
                sql.append(" and (created_at at time zone 'UTC')::date <= :createdTo");
                params.put("createdTo", filter.createdTo);
            }
            return jdbc.sql(sql.append(tail).toString()).params(params);
        }

        private void addFilter(StringBuilder sql, java.util.Map<String, Object> params, String field, Object value, String ignored) {
            if (value != null && !field.equals(ignored)) {
                sql.append(" and ").append(field).append(" = :").append(field);
                params.put(field, value);
            }
        }
    }
}
