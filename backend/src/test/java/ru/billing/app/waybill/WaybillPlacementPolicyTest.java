package ru.billing.app.waybill;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
class WaybillPlacementPolicyTest {
 @Test void twoFortyFootContainersFitAnEightyFootPlatform(){assertThat(WaybillPlacementPolicy.violation(2,80,new BigDecimal("46400"),80,new BigDecimal("72000"))).isNull();}
 @Test void exactLimitsAreAllowed(){assertThat(WaybillPlacementPolicy.violation(2,40,new BigDecimal("60000"),40,new BigDecimal("60000"))).isNull();}
 @Test void lengthIsCheckedIndependentlyOfWeight(){assertThat(WaybillPlacementPolicy.violation(2,80,new BigDecimal("10000"),60,new BigDecimal("72000"))).contains("длина");}
 @Test void weightIsCheckedIndependentlyOfLength(){assertThat(WaybillPlacementPolicy.violation(1,20,new BigDecimal("60000.001"),80,new BigDecimal("60000"))).contains("грузоподъёмность");}
 @Test void thirdContainerIsRejected(){assertThat(WaybillPlacementPolicy.violation(3,60,new BigDecimal("10000"),80,new BigDecimal("72000"))).contains("двух");}
 @Test void unknownCharacteristicsCannotBeGuessed(){assertThat(WaybillPlacementPolicy.violation(1,20,BigDecimal.ONE,null,null)).contains("не указаны");}
}
