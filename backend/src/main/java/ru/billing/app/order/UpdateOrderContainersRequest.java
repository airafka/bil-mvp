package ru.billing.app.order;

import ru.billing.app.reference.EntityReference;

import tools.jackson.databind.annotation.JsonDeserialize;

import com.fasterxml.jackson.annotation.JsonAlias;

import ru.billing.app.reference.PartySelection;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

public record UpdateOrderContainersRequest(@NotNull List<@NotNull @Valid Attributes> containers, @JsonAlias("defaultContainerOwner") @JsonDeserialize(converter = EntityReference.Id.class) UUID defaultContainerOwnerId, @Size(max=1000) List<@NotNull @Valid Addition> additions, @Valid Metadata metadata) {
    public record Metadata(@JsonAlias({"planReceivingDateTime", "plannedShippingDateTime"}) java.time.LocalDateTime plannedAt, @Size(max=255) String consignor, @JsonProperty("consigneeName") @Size(max=255) String consignee,
            @Valid PartySelection shipper, @Valid @JsonProperty("consignee") PartySelection destination) {
        public Metadata(java.time.LocalDateTime plannedAt, String consignor, String consignee) {
            this(plannedAt, consignor, consignee, null, null);
        }
    }
    public UpdateOrderContainersRequest(List<Attributes> containers, UUID defaultContainerOwnerId, List<Addition> additions) { this(containers,defaultContainerOwnerId,additions,null); }
    public UpdateOrderContainersRequest { additions = additions == null ? List.of() : List.copyOf(additions); }
    public UpdateOrderContainersRequest(List<Attributes> containers, UUID defaultContainerOwnerId) { this(containers,defaultContainerOwnerId,List.of()); }
    public UpdateOrderContainersRequest(List<Attributes> containers) { this(containers,null,List.of()); }
    public record Addition(@NotNull @Valid OrderContainerRequest container, UUID railwayCarriageId) {}
    @AssertTrue(message="Укажите реквизиты КТК или собственника по умолчанию")
    public boolean isChangePresent() { return containers != null && (!containers.isEmpty() || defaultContainerOwnerId != null || !additions.isEmpty() || metadata != null); }
    public record Attributes(@NotNull UUID containerId, @JsonAlias({"containerOwner", "ownerContainer"}) @JsonDeserialize(converter = EntityReference.Id.class) UUID ownerClientId,
            @Size(max = 1000, message = "Номера ЗПУ: не более 1000 символов") String sealNumbers,
            @JsonAlias("sealType") @JsonDeserialize(converter = EntityReference.Id.class) UUID sealTypeId, @JsonAlias("dangerClass") @JsonDeserialize(converter = EntityReference.Id.class) UUID hazardClassId) {
        public Attributes {
            sealNumbers = sealNumbers == null || sealNumbers.isBlank() ? null : sealNumbers.trim();
        }
    }
}
