package ru.billing.app.system;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import ru.billing.app.error.ApiException;

@RestController
@RequestMapping("/api/application-clock")
public class ApplicationClockController {
    private final JdbcTemplate jdbc;
    public ApplicationClockController(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    public record State(LocalDate date, LocalDate fixedDate, String mode, String timeZone,
                        OffsetDateTime now, OffsetDateTime systemNow, long version) {}
    public record Change(LocalDate date, @NotNull @Min(0) Long version) {}

    @GetMapping
    @Transactional(readOnly=true)
    public State get() {
        jdbc.execute("select pg_advisory_xact_lock_shared(353535,1)");
        return state();
    }

    @PutMapping
    @Transactional
    public State change(@Valid @RequestBody Change request) {
        if(request.date()!=null && (request.date().getYear()<1 || request.date().getYear()>9999))
            throw new ApiException(HttpStatus.BAD_REQUEST,"INVALID_BUSINESS_DATE","Укажите дату с годом от 1 до 9999");
        jdbc.execute("select pg_advisory_xact_lock(353535,1)");
        int updated=jdbc.update("""
            update application_clock set business_date=?,version=version+1,changed_at=clock_timestamp()
            where id=1 and version=?
            """,request.date(),request.version());
        if(updated==0) throw new ApiException(HttpStatus.CONFLICT,"BUSINESS_DATE_CHANGED",
            "Рабочая дата уже изменена. Обновите календарь и повторите выбор");
        return state();
    }

    private State state() {
        return jdbc.queryForObject("select business_date,version,billing_now() as effective_now,clock_timestamp() as actual_now from application_clock where id=1",
            (rs,n)->{
                var fixed=rs.getObject("business_date",LocalDate.class);
                var now=rs.getObject("effective_now",OffsetDateTime.class).atZoneSameInstant(java.time.ZoneId.of("Europe/Moscow")).toOffsetDateTime();
                return new State(now.toLocalDate(),fixed,fixed==null?"SYSTEM":"FIXED","Europe/Moscow",now,
                    rs.getObject("actual_now",OffsetDateTime.class),rs.getLong("version"));
            });
    }
}
