-- The transport/ownership history remains in container_owner_history.
-- Cancellation keeps document statuses and reverses stock/billing transactionally.
-- Cancellation reasons, composition archives, billing snapshots and the unused
-- integration outbox are intentionally removed. No replacement archive is kept.
DROP TABLE container_movement;
DROP TABLE order_cancellation;
DROP TABLE outbound_data;
