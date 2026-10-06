-- N1 "Hàng chưa lên invoice": lịch sử mỗi lần xuất invoice (POST /trackings/invoice) + tracking đã gom.
-- Tracking chưa có dòng invoice_items nào = chưa từng lên invoice.
-- Sinh bằng: prisma migrate diff --from-schema-datamodel <schema trước> --to-schema-datamodel prisma/schema.prisma --script

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "note" TEXT,
    "tracking_count" INTEGER NOT NULL,
    "line_count" INTEGER NOT NULL,
    "total_jpy" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "tracking_id" UUID,
    "tracking_code" TEXT NOT NULL,
    "order_id" UUID,
    "order_code" TEXT,
    "customer_name" TEXT,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_created_at_idx" ON "invoices"("created_at");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_items_tracking_id_idx" ON "invoice_items"("tracking_id");

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tracking_id_fkey" FOREIGN KEY ("tracking_id") REFERENCES "trackings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

