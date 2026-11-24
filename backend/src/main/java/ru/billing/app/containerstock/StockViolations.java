package ru.billing.app.containerstock;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** The dev_back violation key and document number identify a group of physical units. */
final class StockViolations {
    private record Group(String key, Integer orderNumber) {}
    private record Units(String description, List<String> codes) {
        String sortedCodes() {
            return codes.stream().sorted().collect(Collectors.joining(", "));
        }
    }
    private final Map<Group, Units> groups = new LinkedHashMap<>();

    void add(String key, Integer orderNumber, String unitCode, String description) {
        groups.computeIfAbsent(new Group(key, orderNumber), ignored -> new Units(description, new ArrayList<>()))
                .codes().add(unitCode);
    }

    boolean isEmpty() { return groups.isEmpty(); }

    String originalMessage() {
        return groups.entrySet().stream().map(entry -> {
            var group = entry.getKey();
            var number = group.orderNumber() == null ? "" : group.orderNumber().toString();
            return group.key() + ": [" + number + "; " + entry.getValue().sortedCodes() + "]";
        }).collect(Collectors.joining(", "));
    }

    String detail() {
        return groups.values().stream().map(units -> units.sortedCodes() + ": " + units.description())
                .collect(Collectors.joining("; "));
    }
}
