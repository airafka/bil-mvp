package ru.billing.app.reference;

import ru.billing.app.reference.EntityReference;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.UUID;
public record ContractOption(UUID id, UUID clientId, String name, String contractType, java.time.LocalDate validFrom) {
    @JsonProperty("client")
    public EntityReference client() { return EntityReference.named(clientId, null); }
}
