package ru.billing.app.reference;

import java.util.UUID;
import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.util.StdConverter;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record EntityReference(UUID id, String code, String name) {
    public static EntityReference named(UUID id, String name) {
        return id == null ? null : new EntityReference(id, null, name);
    }

    public static EntityReference coded(UUID id, String code) {
        return id == null ? null : new EntityReference(id, code, null);
    }

    /** Accept an association object as well as the UUID used by earlier MVP clients. */
    public static final class Id extends StdConverter<JsonNode, UUID> {
        @Override
        public UUID convert(JsonNode value) {
            if (value == null || value.isNull()) return null;
            JsonNode id = value.isObject() ? value.get("id") : value;
            if (id == null || !id.isString()) throw new IllegalArgumentException("Expected a UUID or an object with an id");
            return UUID.fromString(id.asString());
        }
    }
}
