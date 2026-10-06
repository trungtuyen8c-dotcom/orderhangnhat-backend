-- Partial unique index: 1 mã tracking mồ côi (order_id IS NULL) chỉ được tồn tại 1 lần.
-- Prisma schema không biểu diễn được partial index -> giữ ở migration SQL thủ công.
-- Trước khi apply trên DB có dữ liệu trùng: chạy prisma/dedupe-orphan-tracking.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "trackings_code_orphan_uniq" ON "trackings" ("code") WHERE "order_id" IS NULL;
