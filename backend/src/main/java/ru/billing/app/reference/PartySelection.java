package ru.billing.app.reference;

import java.util.UUID;
import com.fasterxml.jackson.annotation.JsonCreator;
import jakarta.validation.constraints.Size;

public record PartySelection(UUID id, @Size(max = 255) String name) {
    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public PartySelection(String name) { this(null, name); }
}
