package ru.billing.app.route;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record RouteOrderOption(UUID id, int code, String clientName, String status) {
    @JsonProperty("number")
    public int number() { return code; }

    @JsonProperty("orderStatus")
    public String orderStatus() { return status; }
}
