package ru.billing.app.containerstock;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ContainerStorageDaysTest {
    private long days(String start,String end,String type,String asOf) {
        return ContainerStorageController.storageSpan(OffsetDateTime.parse(start),end==null?null:OffsetDateTime.parse(end),type,LocalDate.parse(asOf))
            .daysWithin(ContainerStorageController.StayPeriod.ALL_TIME);
    }
    @Test void countsBothArrivalAndDepartureDates() {
        assertEquals(3,days("2026-11-10T22:00:00+03:00","2026-11-12T01:00:00+03:00","SHIPPING_ORDER","2026-11-20"));
        assertEquals(1,days("2026-11-10T01:00:00+03:00","2026-11-10T23:00:00+03:00","SHIPPING_ORDER","2026-11-20"));
    }
    @Test void givesChangeDayToNewOwner() {
        assertEquals(2,days("2026-11-10T10:00:00+03:00","2026-11-12T10:00:00+03:00","SERVICE_ORDER","2026-11-20"));
        assertEquals(1,days("2026-11-12T10:00:00+03:00",null,null,"2026-11-12"));
    }
    @Test void userExampleSeptember15Change17Departure20() {
        assertEquals(2,days("2026-09-15T10:00:00+03:00","2026-09-17T10:00:00+03:00","SERVICE_ORDER","2026-09-20"));
        assertEquals(4,days("2026-09-17T10:00:00+03:00","2026-09-20T10:00:00+03:00","SHIPPING_ORDER","2026-09-20"));
    }
    @Test void sameDayIntermediateOwnersHaveZeroDays() {
        assertEquals(0,days("2026-11-12T10:00:00+03:00","2026-11-12T11:00:00+03:00","SERVICE_ORDER","2026-11-20"));
    }
    @Test void openPeriodIncludesWorkingDateAndHandlesLeapDay() {
        assertEquals(3,days("2024-02-28T23:30:00+03:00",null,null,"2024-03-01"));
        assertEquals(0,days("2026-11-12T10:00:00+03:00",null,null,"2026-11-11"));
    }
    @Test void usesMoscowDatesInsteadOfElapsedHoursOrUtcDates() {
        assertEquals(1,days("2026-11-10T21:30:00Z","2026-11-11T20:30:00Z","SHIPPING_ORDER","2026-11-20"));
        assertEquals(0,days("2026-11-10T21:30:00Z","2026-11-11T00:30:00Z","SERVICE_ORDER","2026-11-20"));
    }
    @Test void selectedDatesSplitAtMoscowMidnightAndIncludeShipping() {
        var arrival = OffsetDateTime.parse("2026-11-13T21:30:00Z");
        var transfer = OffsetDateTime.parse("2026-11-16T21:00:00Z");
        var shipping = OffsetDateTime.parse("2026-11-20T09:00:00Z");
        var asOf = LocalDate.of(2026, 11, 25);
        var first = ContainerStorageController.storageSpan(arrival, transfer, "SERVICE_ORDER", asOf);
        var second = ContainerStorageController.storageSpan(transfer, shipping, "SHIPPING_ORDER", asOf);

        assertEquals(1, first.daysWithin(november(16, 18)));
        assertEquals(2, second.daysWithin(november(16, 18)));
        assertEquals(0, first.daysWithin(november(17, 17)));
        assertEquals(1, second.daysWithin(november(17, 17)));
        assertEquals(1, second.daysWithin(november(20, 20)));
    }

    @Test void selectedDatesStopAtWorkingDateForOpenVisit() {
        var open = ContainerStorageController.storageSpan(OffsetDateTime.parse("2026-11-14T09:00:00Z"),
            null, null, LocalDate.of(2026, 11, 17));
        assertEquals(2, open.daysWithin(november(16, 30)));
        assertEquals(0, open.daysWithin(november(18, 30)));
    }

    private ContainerStorageController.StayPeriod november(int from, int to) {
        return new ContainerStorageController.StayPeriod(null, LocalDate.of(2026, 11, from), LocalDate.of(2026, 11, to));
    }

    @Test void historicalReportStopsAtAsOfWithoutSubtractingFutureChangeDay() {
        assertEquals(3,days("2026-11-10T10:00:00+03:00","2026-11-15T10:00:00+03:00","SERVICE_ORDER","2026-11-12"));
        assertEquals(3,days("2026-11-10T10:00:00+03:00","2026-11-15T10:00:00+03:00","SHIPPING_ORDER","2026-11-12"));
    }
}
