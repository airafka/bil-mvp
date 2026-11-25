package ru.billing.app.route;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

public record RouteDetails(RouteSummary route, List<RouteOrderOption> orders) {
    @JsonProperty("receivingOrders")
    public List<RouteOrderOption> receivingOrders() { return route.routeType() == RouteType.RECEIVING ? orders : List.of(); }

    @JsonProperty("shippingOrders")
    public List<RouteOrderOption> shippingOrders() { return route.routeType() == RouteType.SHIPPING ? orders : List.of(); }
}
