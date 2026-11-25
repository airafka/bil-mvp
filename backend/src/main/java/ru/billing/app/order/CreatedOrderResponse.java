package ru.billing.app.order;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record CreatedOrderResponse(UUID id, Integer code, String status) {

    @JsonProperty("number")
    public Integer number() { return code; }

    @JsonProperty("orderStatus")
    public String orderStatus() { return status; }
}
