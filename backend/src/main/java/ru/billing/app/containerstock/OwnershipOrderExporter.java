package ru.billing.app.containerstock;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class OwnershipOrderExporter {
    private record Packet(UUID id, UUID orderId, String payload) {}

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final URI endpoint;
    private final String authorization;

    public OwnershipOrderExporter(JdbcTemplate jdbc, TransactionTemplate transactions,
            @Value("${DATAREON_SERVICE_ORDER_URL:}") String url, @Value("${DATAREON_USERNAME:}") String username,
            @Value("${DATAREON_PASSWORD:}") String password) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        endpoint = url.isBlank() ? null : URI.create(url);
        authorization = username.isEmpty() ? null : "Basic " + Base64.getEncoder()
                .encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8));
    }

    @Scheduled(fixedDelayString = "${datareon.cron.serviceOrderChainPackage:5000}")
    public void sendPending() {
        if (endpoint == null) return;
        while (!Thread.currentThread().isInterrupted()) {
            if (!Boolean.TRUE.equals(transactions.execute(tx -> sendNext()))) return;
        }
    }

    private boolean sendNext() {
        // Claim only an export row. A failed delivery blocks subsequent changes to the same container.
        var packets = jdbc.query("""
                select e.id,e.root_object_id,e.payload from outbound_data e
                where e.entity_type='SERVICE_ORDER' and e.message_type='SERVICE_ORDER_CHAIN_PACKAGE'
                  and e.success is not true and e.attempts<5
                  and (e.last_attempt_at is null or
                       e.last_attempt_at + (5 * e.attempts + 1) * interval '1 minute' <= now() at time zone 'UTC')
                  and not exists (
                    select 1 from outbound_data prior
                    join service_order_container a on a.service_order_id=prior.root_object_id and a.result_status='APPLIED'
                    join service_order_container b on b.container_id=a.container_id and b.result_status='APPLIED'
                    where prior.entity_type=e.entity_type and prior.message_type=e.message_type and prior.success is not true
                      and (prior.created_at,prior.id)<(e.created_at,e.id) and b.service_order_id=e.root_object_id
                  )
                order by e.created_at desc,e.id desc limit 1 for update of e skip locked
                """, (rs,n) -> new Packet(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3)));
        if (packets.isEmpty()) return false;
        Packet packet = packets.getFirst();
        var attemptedAt = LocalDateTime.now(ZoneOffset.UTC);
        // V78 messages retain their original snapshot, including previously attempted deliveries.
        String payload = packet.payload() != null ? packet.payload()
                : jdbc.queryForObject("select ownership_export_payload(?)::text", String.class, packet.orderId());
        if (payload == null) {
            failed(packet.id(), attemptedAt, "Заявка для формирования пакета не найдена");
            return true;
        }
        var builder = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(8))
                .header("Content-Type", "application/json").header("Idempotency-Key",packet.orderId().toString())
                .POST(HttpRequest.BodyPublishers.ofString(payload));
        if (authorization != null) builder.header("Authorization",authorization);
        try {
            var response = http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                failed(packet.id(), attemptedAt, "Datareon вернул HTTP " + response.statusCode());
            } else {
                String body = response.body().strip();
                if (body.length() == 38 && body.startsWith("\"") && body.endsWith("\"")) body = body.substring(1,37);
                UUID message = UUID.fromString(body);
                if (!message.toString().equalsIgnoreCase(body)) throw new IllegalArgumentException();
                jdbc.update("""
                        update outbound_data set success=true,message_id=?,response_code=?,error_message=null,
                            attempts=attempts+1,last_attempt_at=?,updated_at=clock_timestamp() at time zone 'UTC',
                            updated_by='local' where id=?
                        """, message, response.statusCode(), attemptedAt, packet.id());
            }
        } catch (IOException ex) {
            failed(packet.id(), attemptedAt, "Нет ответа от Datareon");
        } catch (IllegalArgumentException ex) {
            failed(packet.id(), attemptedAt, "Datareon вернул некорректный идентификатор сообщения");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            failed(packet.id(), attemptedAt, "Отправка прервана");
        }
        return true;
    }

    private void failed(UUID id, LocalDateTime attemptedAt, String reason) {
        jdbc.update("""
                update outbound_data set success=false,attempts=attempts+1,error_message=?,last_attempt_at=?,
                    updated_at=clock_timestamp() at time zone 'UTC',updated_by='local' where id=?
                """, reason, attemptedAt, id);
    }
}
