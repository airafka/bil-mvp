package ru.billing.app.waybill;

public final class WaybillPlacementPolicy {
    private WaybillPlacementPolicy() {}
    public static int containerFeet(String type) {
        return switch (type) { case "STANDARD_20" -> 20; case "STANDARD_40" -> 40; default -> -1; };
    }
    public static String violation(int feet, Integer capacityFeet) {
        if (feet < 0) return "не определена футовость КТК";
        if (capacityFeet == null) return "не указана длина платформы";
        if (feet > capacityFeet) return "суммарная длина КТК превышает длину платформы";
        return null;
    }
}
