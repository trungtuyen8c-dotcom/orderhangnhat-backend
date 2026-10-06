-- M7-1: hoa don mua dinh theo tracking. M9-2: import sao ke de doi soat tu dong.
-- Chi them cot/bang moi (khong doi du lieu cu) -> an toan khi chay tren production.
BEGIN;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "tracking_id" UUID;

-- CreateIndex
CREATE INDEX "documents_tracking_id_idx" ON "documents"("tracking_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tracking_id_fkey" FOREIGN KEY ("tracking_id") REFERENCES "trackings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "wallet_statement_mappings" (
    "wallet_id" UUID NOT NULL,
    "mapping" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_statement_mappings_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "statement_imports" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "row_count" INTEGER NOT NULL,
    "tolerance_days" INTEGER,
    "mapping" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_by" UUID,
    "committed_at" TIMESTAMP(3),

    CONSTRAINT "statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_import_rows" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_index" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,
    "txn_date" DATE,
    "amount" DECIMAL(16,2),
    "description" TEXT,
    "reference" TEXT,
    "matched_txn_id" UUID,

    CONSTRAINT "statement_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statement_imports_wallet_id_created_at_idx" ON "statement_imports"("wallet_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "statement_imports_wallet_id_file_hash_key" ON "statement_imports"("wallet_id", "file_hash");

-- CreateIndex
CREATE INDEX "statement_import_rows_matched_txn_id_idx" ON "statement_import_rows"("matched_txn_id");

-- CreateIndex
CREATE UNIQUE INDEX "statement_import_rows_import_id_row_index_key" ON "statement_import_rows"("import_id", "row_index");

-- AddForeignKey
ALTER TABLE "wallet_statement_mappings" ADD CONSTRAINT "wallet_statement_mappings_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "statement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_matched_txn_id_fkey" FOREIGN KEY ("matched_txn_id") REFERENCES "wallet_txns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
