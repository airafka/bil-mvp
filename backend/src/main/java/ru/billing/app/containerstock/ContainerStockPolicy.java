package ru.billing.app.containerstock;

import java.util.UUID;

/** Pure lifecycle rules, shared by validation and cancellation; no SQL or billing. */
public final class ContainerStockPolicy {
    private ContainerStockPolicy() {}
    public static String reservationConflict(boolean receiving, String status) {
        if (receiving) return switch(status == null ? "DEPARTED" : status) {
            case "DEPARTED" -> null;
            case "EXPECTED" -> "КТК уже ожидается по поставке";
            case "ON_TERMINAL" -> "КТК уже находится на терминале";
            default -> "КТК зарезервирован для вывоза";
        };
        return switch(status == null ? "DEPARTED" : status) {
            case "ON_TERMINAL" -> null;
            case "EXPECTED" -> "КТК ещё не принят по поставке";
            case "RESERVED_OUT" -> "КТК уже зарезервирован для вывоза";
            default -> "КТК отсутствует в остатках";
        };
    }
    public static boolean canCancel(boolean receiving, boolean completed, String status, UUID currentOrder, UUID cancelledOrder) {
        String required = receiving ? (completed ? "ON_TERMINAL" : "EXPECTED") : (completed ? "DEPARTED" : "RESERVED_OUT");
        return required.equals(status) && cancelledOrder.equals(currentOrder);
    }
}
