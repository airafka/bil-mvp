ALTER TABLE receiving_order DROP CONSTRAINT ck_receiving_order_status;
ALTER TABLE receiving_order ADD CONSTRAINT ck_receiving_order_status CHECK(order_status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED'));
ALTER TABLE shipping_order DROP CONSTRAINT ck_shipping_order_status;
ALTER TABLE shipping_order ADD CONSTRAINT ck_shipping_order_status CHECK(order_status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED'));
ALTER TABLE route DROP CONSTRAINT route_status_check;
ALTER TABLE route ADD CONSTRAINT route_status_check CHECK(status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED'));
ALTER TABLE comprehensive_service_order DROP CONSTRAINT comprehensive_service_order_status_check;
ALTER TABLE comprehensive_service_order ADD CONSTRAINT comprehensive_service_order_status_check CHECK(status IN ('DRAFT','CONFIRMED','COMPLETED','CANCELLED'));

-- Immutable before-reservation state; cancellation restores the previous chain links.
CREATE TABLE container_stock_reservation (
    order_id uuid NOT NULL, order_type varchar(50) NOT NULL,
    container_id uuid NOT NULL REFERENCES container(id),
    previous_client_id uuid REFERENCES client(id),
    previous_receiving_id uuid REFERENCES receiving_order(id),
    previous_shipping_id uuid REFERENCES shipping_order(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(order_id,order_type,container_id)
);
-- Earlier versions recorded the owner and status, but not the chain links.
-- Recover links from earlier transitions; never infer an owner from the order client.
INSERT INTO container_stock_reservation(order_id,order_type,container_id,previous_client_id,previous_receiving_id,previous_shipping_id)
SELECT h.order_id,h.order_type,h.container_id,h.old_client_id,
    (SELECT p.order_id FROM container_owner_history p WHERE p.container_id=h.container_id
        AND p.order_type='RECEIVING_ORDER' AND p.order_id<>h.order_id AND p.created_at<h.created_at
        ORDER BY p.created_at DESC,p.id DESC LIMIT 1),
    (SELECT p.order_id FROM container_owner_history p WHERE p.container_id=h.container_id
        AND p.order_type='SHIPPING_ORDER' AND p.order_id<>h.order_id AND p.created_at<h.created_at
        ORDER BY p.created_at DESC,p.id DESC LIMIT 1)
FROM container_owner_history h
WHERE (h.order_type='RECEIVING_ORDER' AND h.new_status='EXPECTED')
   OR (h.order_type='SHIPPING_ORDER' AND h.new_status='RESERVED_OUT')
ON CONFLICT DO NOTHING;

CREATE TABLE order_cancellation (
    order_id uuid NOT NULL, resource varchar(50) NOT NULL,
    previous_status varchar(30) NOT NULL, reason varchar(1000) NOT NULL,
    cancelled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    details jsonb NOT NULL, billing_snapshot jsonb NOT NULL DEFAULT '[]',
    PRIMARY KEY(order_id,resource)
);
ALTER TABLE container_owner_history ADD COLUMN cancellation boolean NOT NULL DEFAULT false;
