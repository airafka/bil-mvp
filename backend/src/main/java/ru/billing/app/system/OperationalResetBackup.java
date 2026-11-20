package ru.billing.app.system;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import ru.billing.app.error.ApiException;

@Component
public class OperationalResetBackup {
    private final String host, port, database, user, password;
    private final Path directory;

    public OperationalResetBackup(@Value("${DB_HOST:localhost}") String host,
            @Value("${DB_PORT:5432}") String port, @Value("${DB_NAME:billing}") String database,
            @Value("${DB_USER:billing}") String user, @Value("${DB_PASSWORD:billing}") String password,
            @Value("${OPERATIONAL_RESET_BACKUP_DIR:/app/reset-backups}") String directory) {
        this.host = host; this.port = port; this.database = database;
        this.user = user; this.password = password; this.directory = Path.of(directory);
    }

    // A separate connection may read while the reset transaction holds EXCLUSIVE table locks.
    public String create() {
        String name = "before-reset-" + Instant.now().toString().replace(':', '-') + "-" + UUID.randomUUID() + ".dump";
        Path partial = directory.resolve(name + ".partial"), complete = directory.resolve(name);
        Path log = null;
        try {
            Files.createDirectories(directory);
            Files.createFile(partial);
            log = Files.createTempFile(directory, "reset-", ".log");
            execute(List.of("pg_dump", "--host", host, "--port", port, "--username", user,
                    "--dbname", database, "--no-password", "--format=custom", "--lock-wait-timeout=10s",
                    "--file", partial.toString()), log);
            if (Files.size(partial) < 5) throw new IOException("Empty backup");
            execute(List.of("pg_restore", "--list", "--file=/dev/null", partial.toString()), log);
            Files.move(partial, complete);
            return name;
        } catch (IOException exception) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "RESET_BACKUP_FAILED",
                    "Не удалось сохранить резервную копию. Данные не удалены. Проверьте каталог резервных копий и повторите попытку.");
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "RESET_INTERRUPTED", "Очистка прервана. Данные не удалены.");
        } finally {
            try { Files.deleteIfExists(partial); if (log != null) Files.deleteIfExists(log); }
            catch (IOException ignored) { /* Never delete a completed backup. */ }
        }
    }

    private void execute(List<String> command, Path log) throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(new ArrayList<>(command));
        builder.environment().put("PGPASSWORD", password);
        builder.environment().put("PGCONNECT_TIMEOUT", "10");
        builder.environment().put("PGOPTIONS", "-c statement_timeout=120000");
        builder.redirectErrorStream(true).redirectOutput(log.toFile());
        Process process = builder.start();
        try {
            if (!process.waitFor(150, TimeUnit.SECONDS) || process.exitValue() != 0)
                throw new IOException("Backup command failed");
        } finally { if (process.isAlive()) { process.destroyForcibly(); process.waitFor(); } }
    }
}
