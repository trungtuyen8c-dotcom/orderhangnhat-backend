-- Index cho danh sách phân trang server (GET /orders, /trackings) + FK chưa có index (order_items.order_id,
-- trackings.order_id) mà mọi trang danh sách đều include/EXISTS tới.
-- Sinh bằng: prisma migrate diff --from-schema-datamodel <schema cũ> --to-schema-datamodel prisma/schema.prisma --script
-- (không đụng partial index trackings_code_orphan_uniq ở 1_orphan_tracking_unique_index).

-- CreateIndex
CREATE INDEX "orders_order_date_created_at_idx" ON "orders"("order_date", "created_at");

-- CreateIndex
CREATE INDEX "orders_source_order_date_idx" ON "orders"("source", "order_date");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "trackings_order_id_idx" ON "trackings"("order_id");

-- CreateIndex
CREATE INDEX "trackings_created_at_idx" ON "trackings"("created_at");

