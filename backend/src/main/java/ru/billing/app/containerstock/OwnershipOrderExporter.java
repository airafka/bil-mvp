package ru.billing.app.containerstock;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class OwnershipOrderExporter {
    private record Packet(UUID id, String payload) {}

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

    @Scheduled(fixedDelay = 1000)
    public void sendPending() {
        if (endpoint == null) return;
        for (int i = 0; i < 20 && !Thread.currentThread().isInterrupted(); i++) {
            if (!Boolean.TRUE.equals(transactions.execute(tx -> sendNext()))) return;
        }
    }

    private boolean sendNext() {
        // Claim only an export row. A failed delivery blocks subsequent changes to the same container.
        var packets = jdbc.query("""
                select e.service_order_id,e.payload::text from service_order_export e
                where e.sent_at is null and e.next_attempt_at<=now() and not exists (
                    select 1 from service_order_export prior
                    join service_order_container a on a.service_order_id=prior.service_order_id and a.result_status='APPLIED'
                    join service_order_container b on b.container_id=a.container_id and b.result_status='APPLIED'
                    where prior.sent_at is null and prior.sequence_no<e.sequence_no and b.service_order_id=e.service_order_id
                ) order by e.sequence_no limit 1 for update of e skip locked
                """, (rs,n) -> new Packet(rs.getObject(1,UUID.class),rs.getString(2)));
        if (packets.isEmpty()) return false;
        Packet packet = packets.getFirst();
        var builder = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(8))
                .header("Content-Type", "application/json").header("Idempotency-Key",packet.id().toString())
                .POST(HttpRequest.BodyPublishers.ofString(packet.payload()));
        if (authorization != null) builder.header("Authorization",authorization);
        try {
            var response = http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                retry(packet.id(), "Datareon вернул HTTP " + response.statusCode());
            } else {
                String body = response.body().strip();
                if (body.length() == 38 && body.startsWith("\"") && body.endsWith("\"")) body = body.substring(1,37);
                UUID message = UUID.fromString(body);
                if (!message.toString().equalsIgnoreCase(body)) throw new IllegalArgumentException();
                jdbc.update("""
                        update service_order_export set sent_at=clock_timestamp(),message_id=?,last_error=null,
                            attempts=attempts+1 where service_order_id=?
                        """, message, packet.id());
            }
        } catch (IOException ex) {
            retry(packet.id(),"Нет ответа от Datareon");
        } catch (IllegalArgumentException ex) {
            retry(packet.id(),"Datareon вернул некорректный идентификатор сообщения");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            retry(packet.id(),"Отправка прервана");
        }
        return true;
    }

    private void retry(UUID id, String reason) {
        jdbc.update("""
                update service_order_export set attempts=attempts+1,last_error=?,
                    next_attempt_at=clock_timestamp()+interval '5 seconds' * (1 << least(attempts,7))
                where service_order_id=?
                """, reason + ". Отправка будет повторена.", id);
    }
}
