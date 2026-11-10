package ru.billing.app.waybill;
import java.math.BigDecimal;
public final class WaybillPlacementPolicy {
    private WaybillPlacementPolicy() {}
    public static String violation(int count,int feet,BigDecimal gross,Integer capacityFeet,BigDecimal capacityKg) {
        if(count>2)return "допускается не более двух КТК";
        if(capacityFeet==null||capacityKg==null)return "не указаны длина платформы или грузоподъёмность";
        if(feet>capacityFeet)return "суммарная длина КТК превышает длину платформы";
        if(gross.compareTo(capacityKg)>0)return "превышена грузоподъёмность";
        return null;
    }
}
