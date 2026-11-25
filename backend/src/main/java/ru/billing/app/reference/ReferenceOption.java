package ru.billing.app.reference;

import java.util.UUID;

public record ReferenceOption(UUID id, String name, String code) {
    public ReferenceOption(UUID id, String name) { this(id, name, null); }
}

