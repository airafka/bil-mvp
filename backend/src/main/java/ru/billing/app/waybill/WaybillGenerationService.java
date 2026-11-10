package ru.billing.app.waybill;

import java.math.BigDecimal;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import ru.billing.app.error.ApiException;

@Service
public class WaybillGenerationService {
    private static final int TARE_WEIGHT = 3200;
    private static final int NET_WEIGHT_20 = 10000;
    private static final int NET_WEIGHT_40 = 20000;

    private record Platform(UUID id, int length, BigDecimal capacity, boolean hasModel, boolean available) {
        boolean fits(int requiredLength, int grossWeight) {
            return length >= requiredLength && capacity.compareTo(BigDecimal.valueOf(grossWeight)) >= 0;
        }
    }

    private final JdbcTemplate jdbc;
    private final WaybillService waybills;
    public WaybillGenerationService(JdbcTemplate jdbc, WaybillService waybills) { this.jdbc=jdbc; this.waybills=waybills; }

    @Transactional
    public CreatedWaybillResponse generate(GenerateWaybillRequest request) {
        int twenty=request.standard20()==null?-1:request.standard20(), forty=request.standard40()==null?-1:request.standard40();
        long total = (long) twenty + forty;
        if (twenty<0 || forty<0 || total<1 || total>200)
            throw error("GENERATION_COUNT_INVALID", "Укажите от 1 до 200 КТК суммарно");
        // Serialize allocation of free wagons and generated waybill numbers.
        jdbc.execute("select pg_advisory_xact_lock(1743125938)");
        UUID cargo=required("select id from etsng_code where split_part(code,' ',1)='011005'", "Груз Пшеница (011005) отсутствует");
        UUID danger=required("select dp.id from danger_product dp join danger_class dc on dc.id=dp.danger_class_id where dp.identifier=-1 and dc.code='Неопасный груз'", "Класс Неопасный груз отсутствует");
        UUID seal=required("select id from seal_type where code='Иностранное ЗПУ'", "Тип Иностранное ЗПУ отсутствует");
        var platforms = jdbc.query("""
                select c.id, right(t.code, 2)::integer as length, c.lifting_capacity, c.model_id is not null as has_model,
                       not exists (select 1 from waybill_railway_carriage w where w.railway_carriage_id=c.id) as available
                  from railway_carriage c
                  join railway_carriage_type t on t.id=c.type_id
                 where t.code in ('PLATFORM_40','PLATFORM_60','PLATFORM_80') and c.lifting_capacity is not null
                 order by length, c.code
                """, (rs,n) -> new Platform(rs.getObject("id", UUID.class), rs.getInt("length"),
                        rs.getBigDecimal("lifting_capacity"), rs.getBoolean("has_model"), rs.getBoolean("available")));
        var available = new ArrayList<>(platforms.stream().filter(Platform::available).toList());
        String number=jdbc.queryForObject("select n::text from generate_series(1743125938::bigint,1743125938::bigint+(select count(*) from waybill)) n where not exists(select 1 from waybill w where w.number=n::text) order by n limit 1",String.class);
        jdbc.queryForList("select setval('waybill_number_seq', ?, true) where (select last_value from waybill_number_seq) < ?", Long.parseLong(number), Long.parseLong(number));
        var carriages=new ArrayList<WaybillRailwayCarriageRequest>();
        int nextSeal=jdbc.queryForObject("select greatest(7000000,coalesce(max(zpu::integer),0))+1 from waybill_zpu where zpu ~ '^[0-9]{7}$'",Integer.class);
        if((long)nextSeal+total-1>9999999) throw error("SEAL_NUMBERS_EXHAUSTED", "Исчерпан диапазон демонстрационных номеров ЗПУ");
        while(twenty>0 || forty>0) {
            int fortyOnWagon = Math.min(2, forty);
            int twentyOnWagon = Math.min(2 - fortyOnWagon, twenty);
            int length = 40 * fortyOnWagon + 20 * twentyOnWagon;
            int grossWeight = (NET_WEIGHT_40 + TARE_WEIGHT) * fortyOnWagon
                    + (NET_WEIGHT_20 + TARE_WEIGHT) * twentyOnWagon;
            UUID wagon = allocatePlatform(available, platforms, length, grossWeight);
            var containers = new ArrayList<WaybillContainerRequest>(2);
            for (int i = 0; i < fortyOnWagon; i++) containers.add(container(false, seal, nextSeal++));
            for (int i = 0; i < twentyOnWagon; i++) containers.add(container(true, seal, nextSeal++));
            carriages.add(new WaybillRailwayCarriageRequest(wagon, containers));
            forty -= fortyOnWagon;
            twenty -= twentyOnWagon;
        }
        return waybills.create(new CreateWaybillRequest(null,1001,2001,"ФИТ",null,null,carriages,
            List.of(new WaybillProductRequest(cargo,null,null,null,danger,null)),number));
    }
    private UUID allocatePlatform(List<Platform> available, List<Platform> templates, int length, int grossWeight) {
        for (int i = 0; i < available.size(); i++) {
            if (available.get(i).fits(length, grossWeight)) return available.remove(i).id();
        }
        var template = templates.stream().filter(p -> p.hasModel() && p.fits(length, grossWeight)).findFirst()
                .orElseThrow(() -> error("GENERATION_REFERENCE_MISSING",
                        "Нужен образец платформы от %d футов с моделью и грузоподъёмностью от %d кг".formatted(length, grossWeight)));
        UUID wagon = UUID.randomUUID();
        jdbc.update("""
                insert into railway_carriage(id,code,type_id,model_id,lifting_capacity,date_depot_repair)
                select ?,?,type_id,model_id,lifting_capacity,date '2032-06-15' from railway_carriage where id=?
                """, wagon, nextWagonNumber(), template.id());
        return wagon;
    }

    private WaybillContainerRequest container(boolean twenty,UUID seal,int sealNumber) {
        UUID id=UUID.randomUUID();
        jdbc.update("insert into container(id,code,weight,container_type,lifting_capacity) values (?,?,?,?,?)",id,nextContainerNumber(),TARE_WEIGHT,twenty?"STANDARD_20":"STANDARD_40",twenty?27280:29300);
        BigDecimal net=BigDecimal.valueOf(twenty?NET_WEIGHT_20:NET_WEIGHT_40);
        return new WaybillContainerRequest(id,net.add(BigDecimal.valueOf(TARE_WEIGHT)),null,null,String.format(Locale.ROOT,"%07d",sealNumber),seal,net);
    }
    private String nextContainerNumber() {
        // Generation holds the advisory lock. Each new container reserves its serial by insertion.
        int serial=jdbc.queryForObject("select greatest(900000,coalesce(max(substring(code from 5 for 6)::integer),0))+1 from container where code ~ '^TKRU[0-9]{7}$'",Integer.class);
        if(serial>999999) throw error("CONTAINER_NUMBERS_EXHAUSTED", "Исчерпан диапазон демонстрационных номеров КТК TKRU");
        return ContainerNumber.format("TKR",serial);
    }
    private String nextWagonNumber() {
        int body=jdbc.queryForObject("select greatest(4200000,coalesce(max(left(code,7)::integer),0))+1 from railway_carriage where code ~ '^42[0-9]{6}$'",Integer.class);
        if(body>4299999) throw error("WAGON_NUMBERS_EXHAUSTED", "Исчерпан диапазон демонстрационных номеров платформ");
        return RailwayCarriageNumber.formatPlatform(body);
    }
    private UUID required(String sql,String message) { var ids=jdbc.query(sql,(rs,n)->rs.getObject(1,UUID.class)); if(ids.size()!=1) throw error("GENERATION_REFERENCE_MISSING",message); return ids.getFirst(); }
    private ApiException error(String code,String message) { return new ApiException(HttpStatus.BAD_REQUEST,code,message); }
}
