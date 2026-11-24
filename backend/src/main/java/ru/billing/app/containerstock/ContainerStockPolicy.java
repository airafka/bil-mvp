package ru.billing.app.containerstock;

import java.util.UUID;

/** Physical stock transitions shared by numbered containers and wagons. */
public final class ContainerStockPolicy {
    private ContainerStockPolicy() {}

    enum RelatedOrder { RECEIVING, SHIPPING, NONE }

    enum Violation {
        RECEIVING_ALREADY_RESERVED("ReceivingAlreadyReserved", "уже ожидается по поставке", RelatedOrder.RECEIVING),
        RECEIVING_ALREADY_IN_REMAINS("ReceivingAlreadyInRemains", "уже находится на терминале", RelatedOrder.RECEIVING),
        RECEIVING_ALREADY_IN_SHIPPING("ReceivingAlreadyInShipping", "зарезервирован для вывоза", RelatedOrder.SHIPPING),
        SHIPPING_MISSING_IN_REMAINS("ShippingMissingInRemains", "отсутствует в остатках", RelatedOrder.NONE),
        SHIPPING_NOT_RECEIVED("ShippingNotReceived", "ещё не принят по поставке", RelatedOrder.RECEIVING),
        SHIPPING_ALREADY_RESERVED("ShippingAlreadyReserved", "уже зарезервирован для вывоза", RelatedOrder.SHIPPING),
        CANCEL_RECEIVING_IN_SHIPPING("CancelReceivingInShipping", "зарезервирован для вывоза", RelatedOrder.SHIPPING),
        CANCEL_RECEIVING_DEPARTED("CancelReceivingDeparted", "уже выбыл с терминала", RelatedOrder.SHIPPING),
        CANCEL_RECEIVING_RESERVED_LATER("CancelReceivingReservedLater", "участвует в последующей поставке", RelatedOrder.RECEIVING),
        CANCEL_SHIPPING_EXPECTED("CancelShippingExpected", "ожидается по следующей поставке", RelatedOrder.RECEIVING),
        CANCEL_SHIPPING_RECEIVED("CancelShippingReceived", "уже принят по следующей поставке", RelatedOrder.RECEIVING),
        CANCEL_SHIPPING_RESERVED_LATER("CancelShippingReservedLater", "участвует в последующем вывозе", RelatedOrder.SHIPPING);

        private final String sourceKey;
        private final String reason;
        private final RelatedOrder relatedOrder;

        Violation(String sourceKey, String reason, RelatedOrder relatedOrder) {
            this.sourceKey = sourceKey;
            this.reason = reason;
            this.relatedOrder = relatedOrder;
        }

        String key(String prefix) { return prefix + "." + sourceKey; }
        String description(String item) { return item + " " + reason; }
        RelatedOrder relatedOrder() { return relatedOrder; }
    }

    static Violation reservationViolation(boolean receiving, String status) {
        String current = status == null ? "DEPARTED" : status;
        if (receiving) return switch (current) {
            case "DEPARTED" -> null;
            case "EXPECTED" -> Violation.RECEIVING_ALREADY_RESERVED;
            case "ON_TERMINAL" -> Violation.RECEIVING_ALREADY_IN_REMAINS;
            case "RESERVED_OUT" -> Violation.RECEIVING_ALREADY_IN_SHIPPING;
            default -> throw new IllegalArgumentException("Unknown stock status: " + current);
        };
        return switch (current) {
            case "ON_TERMINAL" -> null;
            case "EXPECTED" -> Violation.SHIPPING_NOT_RECEIVED;
            case "RESERVED_OUT" -> Violation.SHIPPING_ALREADY_RESERVED;
            case "DEPARTED" -> Violation.SHIPPING_MISSING_IN_REMAINS;
            default -> throw new IllegalArgumentException("Unknown stock status: " + current);
        };
    }

    public static String reservationConflict(boolean receiving, String status) {
        var conflict = reservationViolation(receiving, status);
        return conflict == null ? null : conflict.description("КТК");
    }

    public static boolean canCancel(boolean receiving, boolean completed, String status, UUID currentOrder, UUID cancelledOrder) {
        String required = receiving ? (completed ? "ON_TERMINAL" : "EXPECTED") : (completed ? "DEPARTED" : "RESERVED_OUT");
        return required.equals(status) && cancelledOrder.equals(currentOrder);
    }

    static Violation completedCancellationViolation(boolean receiving, String status, UUID currentOrder, UUID cancelledOrder) {
        if (canCancel(receiving, true, status, currentOrder, cancelledOrder)) return null;
        if (receiving) {
            if ("RESERVED_OUT".equals(status)) return Violation.CANCEL_RECEIVING_IN_SHIPPING;
            if (status == null || "DEPARTED".equals(status)) return Violation.CANCEL_RECEIVING_DEPARTED;
            return Violation.CANCEL_RECEIVING_RESERVED_LATER;
        }
        if ("EXPECTED".equals(status)) return Violation.CANCEL_SHIPPING_EXPECTED;
        if ("ON_TERMINAL".equals(status)) return Violation.CANCEL_SHIPPING_RECEIVED;
        return Violation.CANCEL_SHIPPING_RESERVED_LATER;
    }
}
