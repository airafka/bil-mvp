package ru.billing.app.waybill;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
class WaybillPlacementPolicyTest {
 @Test void standardTypesDefineLength(){assertThat(WaybillPlacementPolicy.containerFeet("STANDARD_20")).isEqualTo(20);assertThat(WaybillPlacementPolicy.containerFeet("STANDARD_40")).isEqualTo(40);}
 @Test void fourTwentyFootContainersFitEighty(){assertThat(WaybillPlacementPolicy.violation(4*20,80)).isNull();}
 @Test void twoFortyFootContainersFitEighty(){assertThat(WaybillPlacementPolicy.violation(2*40,80)).isNull();}
 @Test void mixedThreeContainersFitEighty(){assertThat(WaybillPlacementPolicy.violation(40+20+20,80)).isNull();}
 @Test void excessLengthIsRejected(){assertThat(WaybillPlacementPolicy.violation(5*20,80)).contains("длина");assertThat(WaybillPlacementPolicy.violation(40+40,60)).contains("длина");}
 @Test void unknownLengthCannotBeGuessed(){assertThat(WaybillPlacementPolicy.violation(20,null)).contains("не указана");assertThat(WaybillPlacementPolicy.containerFeet("OTHER")).isEqualTo(-1);assertThat(WaybillPlacementPolicy.violation(-1,80)).contains("футовость");}
}
