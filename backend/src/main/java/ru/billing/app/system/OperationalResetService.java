package ru.billing.app.system;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.billing.app.error.ApiException;

@Service
public class OperationalResetService {
    static final List<String> CLEARED = List.of(
        "container_owner", "container_owner_history", "container_period", "container_visit",
        "railway_carriage_owner_history", "inbound_event", "shipping_order_container_qty",
        "receiving_order", "receiving_order_container",
        "receiving_order_container_item", "route", "service_order", "service_order_container", "service_order_export",
        "shipping_order", "shipping_order_container", "shipping_order_container_item", "shipping_order_railway_carriage",
        "waybill", "waybill_container", "waybill_container_relocation",
        "waybill_product", "waybill_railway_carriage", "waybill_zpu");
    static final List<String> PRESERVED = List.of(
        "application_clock", "client", "client_driver", "client_related_entity", "client_vehicle", "inbound_event_config",
        "container", "contract", "danger_class",
        "danger_product", "etsng_code", "flyway_schema_history", "payer", "railway_carriage",
        "railway_carriage_model", "railway_carriage_type", "railway_station", "seal_type", "terminal_area_catalog");
    private final JdbcTemplate jdbc;
    private final OperationalResetBackup backup;
    private final boolean enabled;

    public record Preview(String token, Map<String, Long> counts, long totalRows) { }
    public record ResetRequest(String confirmation, String token) { }
    public record ResetResult(boolean cleared, String backupFile) { }

    public OperationalResetService(JdbcTemplate jdbc, OperationalResetBackup backup,
            @Value("${OPERATIONAL_RESET_ENABLED:false}") boolean enabled) {
        this.jdbc = jdbc; this.backup = backup; this.enabled = enabled;
    }

    public boolean enabled() { return enabled; }

    @Transactional(readOnly = true, isolation = org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public Preview preview() { requireEnabled(); validateSchema(); return currentPreview(); }

    @Transactional(timeout = 210)
    public ResetResult reset(ResetRequest request) {
        requireEnabled();
        if (!"УДАЛИТЬ".equals(request.confirmation()) || request.token() == null)
            throw new ApiException(HttpStatus.BAD_REQUEST, "RESET_CONFIRMATION_REQUIRED", "Для очистки введите УДАЛИТЬ.");
        try {
            if (!Boolean.TRUE.equals(jdbc.queryForObject("select pg_try_advisory_xact_lock(729458201)", Boolean.class)))
                throw new ApiException(HttpStatus.CONFLICT, "RESET_BUSY", "Очистка уже выполняется. Дождитесь результата.");
            jdbc.execute("set local lock_timeout = '10s'");
            validateSchema();
            // Block writes and SELECT FOR UPDATE; allow pg_dump and ordinary readers.
            jdbc.execute("lock table " + qualified(allTables()) + " in exclusive mode");
            Preview current = currentPreview();
            if (!current.token().equals(request.token()))
                throw new ApiException(HttpStatus.CONFLICT, "RESET_CHANGED", "Данные изменились. Обновите список и подтвердите очистку заново.");
            if (current.totalRows() == 0) return new ResetResult(false, null);
            Map<String, String> retained = fingerprints(PRESERVED);
            String name = backup.create();
            jdbc.execute("truncate table " + qualified(CLEARED) + " continue identity restrict");
            if (!retained.equals(fingerprints(PRESERVED)) || currentPreview().totalRows() != 0)
                throw new ApiException(HttpStatus.CONFLICT, "RESET_VERIFICATION_FAILED", "Проверка очистки не пройдена. Изменения отменены.");
            return new ResetResult(true, name);
        } catch (DataAccessException exception) {
            throw new ApiException(HttpStatus.CONFLICT, "RESET_DATABASE_BUSY",
                    "Не удалось завершить очистку: данные заняты или появились новые зависимости. Изменения отменены. Повторите попытку позже.");
        }
    }

    private void requireEnabled() {
        if (!enabled) throw new ApiException(HttpStatus.NOT_FOUND, "RESET_DISABLED", "Очистка в этом окружении отключена.");
    }

    private Set<String> allTables() { Set<String> tables = new TreeSet<>(CLEARED); tables.addAll(PRESERVED); return tables; }

    private void validateSchema() {
        Set<String> actual = new TreeSet<>(jdbc.queryForList("select tablename from pg_tables where schemaname = 'public'", String.class));
        if (!actual.equals(allTables()))
            throw new ApiException(HttpStatus.CONFLICT, "RESET_SCHEMA_CHANGED", "Состав таблиц изменился. Очистка остановлена до проверки разработчиком.");
        String names = "'" + String.join("', '", CLEARED) + "'";
        Long incoming = jdbc.queryForObject("""
            select count(*) from pg_constraint fk
            join pg_class target on target.oid=fk.confrelid
            join pg_namespace tn on tn.oid=target.relnamespace
            join pg_class source on source.oid=fk.conrelid
            join pg_namespace sn on sn.oid=source.relnamespace
            where fk.contype='f' and tn.nspname='public' and target.relname in (
            """ + names + ") and not (sn.nspname='public' and source.relname in (" + names + "))", Long.class);
        if (incoming != null && incoming > 0)
            throw new ApiException(HttpStatus.CONFLICT, "RESET_NEW_DEPENDENCY", "Появились новые связи с сохраняемыми данными. Очистка остановлена до проверки разработчиком.");
        // RESTRICT remains the final safeguard against concurrent schema changes.
    }

    private String qualified(Iterable<String> tables) {
        var names = new java.util.ArrayList<String>();
        tables.forEach(table -> names.add("public." + table));
        return String.join(", ", names);
    }

    private Map<String, String> fingerprints(List<String> tables) {
        Map<String, String> result = new LinkedHashMap<>();
        for (String table : tables) result.put(table, jdbc.queryForObject(
            "select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(t)::text, chr(10) order by to_jsonb(t)::text), '')) from public." + table + " t", String.class));
        return result;
    }

    private Preview currentPreview() {
        Map<String, String> fingerprints = fingerprints(CLEARED);
        Map<String, Long> counts = new LinkedHashMap<>();
        fingerprints.forEach((table, fingerprint) -> counts.put(table, Long.parseLong(fingerprint.split(":", 2)[0])));
        try {
            String source = jdbc.queryForObject("select current_database()", String.class) + fingerprints;
            String token = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8)));
            return new Preview(token, counts, counts.values().stream().mapToLong(Long::longValue).sum());
        } catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
}
